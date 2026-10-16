"""全端点骨架测试：状态码与响应形状符合 SPEC §4.2。"""

import json

import pytest
from httpx import ASGITransport, AsyncClient

from novel_forge_sidecar.main import app
from novel_forge_sidecar.services.embedder import EMBEDDING_DIM


@pytest.fixture()
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _read_sse(resp) -> list[dict]:
    """把 SSE 响应体解析成 JSON 帧列表。"""
    frames: list[dict] = []
    async for line in resp.aiter_lines():
        if line.startswith("data: "):
            frames.append(json.loads(line[len("data: "):]))
    return frames


# ---------------------------------------------------------------------------
# 非 SSE 端点
# ---------------------------------------------------------------------------


async def test_embed_shape(client: AsyncClient) -> None:
    resp = await client.post("/embed", json={"texts": ["你好", "世界"]})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["vectors"]) == 2
    assert all(len(v) == EMBEDDING_DIM for v in body["vectors"])


async def test_embed_deterministic(client: AsyncClient) -> None:
    """同一文本两次请求应得到完全相同的向量。"""
    r1 = await client.post("/embed", json={"texts": ["确定性测试"]})
    r2 = await client.post("/embed", json={"texts": ["确定性测试"]})
    assert r1.json()["vectors"] == r2.json()["vectors"]


async def test_rag_index_and_query(client: AsyncClient) -> None:
    index_resp = await client.post(
        "/rag/index",
        json={
            "styleId": "s1",
            "chunks": [
                {"styleId": "s1", "bookId": "b1", "text": "第一段", "sceneType": "daily"},
                {"styleId": "s1", "bookId": "b1", "text": "第二段", "sceneType": "battle"},
            ],
        },
    )
    assert index_resp.status_code == 200
    assert index_resp.json() == {"ok": True, "count": 2}

    query_resp = await client.post(
        "/rag/query", json={"styleId": "s1", "query": "第一段", "topK": 5}
    )
    assert query_resp.status_code == 200
    assert "results" in query_resp.json()
    assert isinstance(query_resp.json()["results"], list)


async def test_rag_query_empty(client: AsyncClient) -> None:
    """未建索引的 styleId 查询返回空列表。"""
    resp = await client.post(
        "/rag/query", json={"styleId": "不存在", "query": "任意", "topK": 3}
    )
    assert resp.status_code == 200
    assert resp.json()["results"] == []


async def test_discriminator_score(client: AsyncClient) -> None:
    resp = await client.post(
        "/discriminator/score", json={"styleId": "s1", "text": "一段文本"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["score"] == 0.5
    assert body["verdict"] == "unknown"


async def test_reward_score(client: AsyncClient) -> None:
    resp = await client.post("/reward/score", json={"features": [[0.1, 0.2], [0.3]]})
    assert resp.status_code == 200
    assert len(resp.json()["scores"]) == 2


async def test_scene_classify(client: AsyncClient) -> None:
    resp = await client.post(
        "/scene/classify", json={"text": "两人拔剑相向，鲜血飞溅，杀气冲天。"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sceneType"] == "battle"
    assert 0.0 <= body["confidence"] <= 1.0


async def test_style_get_404_and_delete(client: AsyncClient) -> None:
    resp = await client.get("/style/不存在")
    assert resp.status_code == 404
    del_resp = await client.delete("/style/不存在")
    assert del_resp.status_code == 200
    assert del_resp.json()["ok"] is True


# ---------------------------------------------------------------------------
# SSE 端点
# ---------------------------------------------------------------------------


async def _assert_sse_protocol(frames: list[dict]) -> None:
    """通用断言：中间帧为 {stage, progress}，最后一帧 done=true。"""
    assert len(frames) >= 2
    for frame in frames[:-1]:
        assert "stage" in frame
        assert 0.0 <= frame["progress"] <= 1.0
    assert frames[-1]["done"] is True


async def test_style_analyze_sse(client: AsyncClient, tmp_path) -> None:
    """真实流水线：写一个两章小书，验证 SSE 协议与 7 阶段齐全。"""
    book = tmp_path / "书1.txt"
    chapters = []
    for i in range(1, 3):
        paras = [
            f"“出剑吧。”他冷声道。第{i}章第{j}段，剑光如雪，杀气冲天。"
            for j in range(1, 7)
        ]
        chapters.append(f"第{i}章 试炼\n" + "\n".join(paras))
    book.write_text("\n\n".join(chapters), encoding="utf-8")
    async with client.stream(
        "POST",
        "/style/analyze",
        json={"authorName": "测试", "books": [{"title": "书1", "path": str(book)}]},
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        frames = await _read_sse(resp)
    await _assert_sse_protocol(frames)
    # 7 阶段流水线各出现一次
    stages = {f["stage"] for f in frames[:-1]}
    assert "chunking" in stages and "embedding" in stages and "discriminator" in stages
    assert "styleId" in frames[-1]


async def test_reward_train_sse(client: AsyncClient) -> None:
    """Phase 4.9 起训练要求 ≥100 样本，此处构造 100 条最小样本验证 SSE 协议。"""
    samples = [
        {
            "projectId": "p1",
            "context": "ctx",
            "chosen": f"选中文本{i}，多一句。",
            "rejected": f"落选{i}",
            "reasons": [],
        }
        for i in range(100)
    ]
    async with client.stream(
        "POST",
        "/reward/train",
        json={"samples": samples},
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        frames = await _read_sse(resp)
    await _assert_sse_protocol(frames)


async def test_lora_infer_sse(client: AsyncClient) -> None:
    async with client.stream(
        "POST", "/lora/infer", json={"styleId": "s1", "prompt": "写一段开头"}
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        frames = await _read_sse(resp)
    await _assert_sse_protocol(frames)
