"""Phase 4.9-4.11 测试：奖励模型训练 / 演化模板提取 / 提示词进化。"""

import json

import pytest
from httpx import ASGITransport, AsyncClient

from novel_forge_sidecar.main import app
from novel_forge_sidecar.services.reward_model import RewardModel


@pytest.fixture()
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _chosen(i: int) -> str:
    """合成「被选中」文本：多段落、对话占比高、带钩子词。"""
    return (
        f"「快走！他们要来了{i}号。」他压低声音喊道。\n\n"
        "突然，巷口传来一阵急促的脚步声。\n\n"
        "「谁？」她猛地回头。\n\n"
        "没想到，站在那里的竟然是失踪多年的师兄。"
    )


def _rejected(i: int) -> str:
    """合成「落选」文本：单长段、无对话、无钩子。"""
    return (
        f"他慢慢地走在第{i}条长长的街道上，四周安静得只能听见自己的呼吸声，"
        "两旁的树影在地上拉得很长很长，时间仿佛停滞了一般没有任何波澜。"
    )


def _samples(n: int) -> list[dict]:
    return [
        {
            "projectId": "p1",
            "context": f"上下文{i}",
            "chosen": _chosen(i),
            "rejected": _rejected(i),
            "reasons": [],
        }
        for i in range(n)
    ]


async def _read_sse(resp) -> list[dict]:
    frames: list[dict] = []
    async for line in resp.aiter_lines():
        if line.startswith("data: "):
            frames.append(json.loads(line[len("data: ") :]))
    return frames


async def _train(client: AsyncClient, n: int = 120) -> list[dict]:
    async with client.stream(
        "POST", "/reward/train", json={"samples": _samples(n)}
    ) as resp:
        assert resp.status_code == 200
        return await _read_sse(resp)


# ---------------------------------------------------------------------------
# 4.9 奖励模型训练
# ---------------------------------------------------------------------------


async def test_reward_train_120_samples_sse_and_metrics(client: AsyncClient) -> None:
    """120 条合成样本：SSE 阶段完整，末帧 metrics 合理（合成数据准确率 > 0.6）。"""
    frames = await _train(client, 120)
    stages = [f["stage"] for f in frames[:-1]]
    assert "feature-extraction" in stages
    assert "training" in stages
    assert "evaluating" in stages
    assert stages.index("feature-extraction") < stages.index("training") < stages.index("evaluating")

    done = frames[-1]
    assert done["done"] is True
    assert done["sampleCount"] == 120
    assert done["version"].startswith("v")
    metrics = done["metrics"]
    assert metrics["accuracy"] > 0.6
    assert -1.0 <= metrics["kendallTau"] <= 1.0
    assert metrics["valPairs"] >= 1
    assert metrics["featureDim"] > 0


async def test_reward_train_99_samples_rejected(client: AsyncClient) -> None:
    """99 样本被拒：400 + 明确说明不足数量与所需数量。"""
    resp = await client.post("/reward/train", json={"samples": _samples(99)})
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "99" in detail and "100" in detail


async def test_reward_score_with_model(client: AsyncClient) -> None:
    """训练后 /reward/score 走模型：chosen 风格文本得分应高于 rejected 风格。"""
    await _train(client, 120)
    resp = await client.post(
        "/reward/score", json={"texts": [_chosen(999), _rejected(999)]}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["modelVersion"] is not None
    [s_chosen, s_rejected] = body["scores"]
    assert 0.0 <= s_rejected < s_chosen <= 1.0


async def test_reward_score_without_model(client: AsyncClient) -> None:
    """无模型时回退启发式 baseline：分数在 (0,1) 且确定性，modelVersion 为空。"""
    payload = {"texts": [_chosen(1), _rejected(1)]}
    r1 = await client.post("/reward/score", json=payload)
    r2 = await client.post("/reward/score", json=payload)
    assert r1.status_code == 200
    assert r1.json()["modelVersion"] is None
    assert r1.json()["scores"] == r2.json()["scores"]
    assert all(0.0 < s < 1.0 for s in r1.json()["scores"])


async def test_reward_score_features_path(client: AsyncClient) -> None:
    """兼容 Phase 1 契约：直接传 features 也能打分。"""
    resp = await client.post("/reward/score", json={"features": [[0.1, 0.2], [0.3]]})
    assert resp.status_code == 200
    assert len(resp.json()["scores"]) == 2


async def test_reward_model_persistence(tmp_path) -> None:
    """训练后模型写入 npz + latest 指针，新实例可从磁盘加载同一版本。"""
    from novel_forge_sidecar.models.schemas import PreferenceSample

    model_dir = tmp_path / "reward"
    m1 = RewardModel(model_dir=model_dir)
    samples = [
        PreferenceSample(
            project_id="p1", context="c", chosen=_chosen(i), rejected=_rejected(i)
        )
        for i in range(120)
    ]
    async for _ in m1.train_stream(samples):
        pass
    assert (model_dir / f"{m1.version}.npz").exists()
    assert (model_dir / "latest.json").exists()

    m2 = RewardModel(model_dir=model_dir)
    assert m2.version == m1.version
    assert m2.score_texts([_chosen(1)]) == m1.score_texts([_chosen(1)])


# ---------------------------------------------------------------------------
# 4.10 演化模式学习
# ---------------------------------------------------------------------------


async def test_extract_templates_direction(client: AsyncClient) -> None:
    """有明显特征差异的样本组应提取出方向正确的模板（如对话占比提升）。"""
    resp = await client.post(
        "/evolution/extract-templates", json={"samples": _samples(30)}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["message"] == ""
    templates = body["templates"]
    assert templates, "应提取出至少一个模板"

    by_name = {t["name"]: t for t in templates}
    assert "提升对话占比" in by_name
    t = by_name["提升对话占比"]
    assert t["featureDeltas"]["dialogueRatio"] > 0
    assert t["support"] >= 3
    assert 0.0 < t["confidence"] <= 1.0
    assert t["instruction"]
    # 模板按置信度降序
    confidences = [x["confidence"] for x in templates]
    assert confidences == sorted(confidences, reverse=True)


async def test_extract_templates_insufficient(client: AsyncClient) -> None:
    """样本不足：返回空模板列表 + 提示信息。"""
    resp = await client.post(
        "/evolution/extract-templates", json={"samples": _samples(5)}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["templates"] == []
    assert "5" in body["message"]


async def test_extract_templates_persisted(client: AsyncClient, tmp_path) -> None:
    """提取结果持久化到 models/evolution/templates.json。"""
    await client.post("/evolution/extract-templates", json={"samples": _samples(30)})
    path = tmp_path / "evolution" / "templates.json"
    assert path.exists()
    data = json.loads(path.read_text(encoding="utf-8"))
    assert len(data) >= 1
    assert "featureDeltas" in data[0]


# ---------------------------------------------------------------------------
# 4.11 提示词进化
# ---------------------------------------------------------------------------


async def test_prompt_template_version_increment(client: AsyncClient) -> None:
    """连续创建两版：version 1→2 且 parentVersion 正确，列表含全部版本。"""
    payload = {"nodeType": "generate", "baseTemplate": "你是网文写手，请续写。"}
    r1 = await client.post("/evolution/prompt-templates", json=payload)
    assert r1.status_code == 200
    v1 = r1.json()
    assert v1["version"] == 1
    assert v1["parentVersion"] is None

    r2 = await client.post("/evolution/prompt-templates", json=payload)
    v2 = r2.json()
    assert v2["version"] == 2
    assert v2["parentVersion"] == 1

    listed = await client.get("/evolution/prompt-templates")
    assert listed.status_code == 200
    templates = listed.json()["templates"]
    versions = [t["version"] for t in templates]
    assert versions == [1, 2]


async def test_prompt_template_embeds_improvements(client: AsyncClient) -> None:
    """先提取演化模板再生成提示词：内容应包含改进指令与 basedOn 引用。"""
    await client.post("/evolution/extract-templates", json={"samples": _samples(30)})
    resp = await client.post(
        "/evolution/prompt-templates",
        json={"nodeType": "generate", "baseTemplate": "基础模板。"},
    )
    body = resp.json()
    assert "改进指令" in body["content"]
    assert body["basedOn"], "应引用演化模板 id"


async def test_prompt_templates_filter_by_node_type(client: AsyncClient) -> None:
    """列表支持按 nodeType 过滤。"""
    await client.post(
        "/evolution/prompt-templates",
        json={"nodeType": "improve", "baseTemplate": "改进模板。"},
    )
    resp = await client.get("/evolution/prompt-templates", params={"nodeType": "improve"})
    templates = resp.json()["templates"]
    assert len(templates) == 1
    assert templates[0]["nodeType"] == "improve"
