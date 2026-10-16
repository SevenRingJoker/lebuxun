"""Phase 5 风格系统测试：书籍加载 / 指纹增强 / 风格报告 / 判别器 / 流水线 / API 端到端。

全部离线可跑：Embedder 用 Mock，LLM 走模板降级或假 client。
"""

import json
import zipfile
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from novel_forge_sidecar.main import app
from novel_forge_sidecar.models.schemas import BookInput, Done, Progress
from novel_forge_sidecar.services.book_loader import load_book
from novel_forge_sidecar.services.discriminator import (
    MIN_TRAIN_SAMPLES,
    STYLE_FEATURE_DIM,
    StyleDiscriminator,
    extract_style_features,
)
from novel_forge_sidecar.services.embedder import MockEmbedder
from novel_forge_sidecar.services.profile_store import ProfileStore
from novel_forge_sidecar.services.style_analyzer import PIPELINE_STAGES, StyleAnalyzer
from novel_forge_sidecar.services.style_report import llm_analyze
from novel_forge_sidecar.services.stylometry import compute_stylometry
from novel_forge_sidecar.services.vector_store import VectorStore
from novel_forge_sidecar.utils.text import Chapter

# ---------------------------------------------------------------------------
# 测试素材
# ---------------------------------------------------------------------------


def _write_book(path, title: str, n_chapters: int = 2, n_paras: int = 6):
    """生成一本带章节标题的小书：对白多、短句多、含比喻标记。"""
    parts: list[str] = []
    for i in range(1, n_chapters + 1):
        parts.append(f"第{i}章 {title}试炼")
        for j in range(1, n_paras + 1):
            parts.append(
                f"“出剑吧。”他冷声道。剑光仿佛秋水，照亮了第{i}章第{j}段的夜色。"
            )
    path.write_text("\n".join(parts), encoding="utf-8")
    return path


def _make_chapters() -> list[Chapter]:
    """4 章素材：前两章反复出现“青冥”，供 signature_words 的 df 阈值检验。"""
    chapters: list[Chapter] = []
    for i in range(4):
        if i < 2:
            text = "青冥剑出鞘，青冥如云。他的剑仿佛秋水，长夜漫漫。"
        else:
            text = "黄沙漫天，驼铃远去。旅人裹紧斗篷，走进暮色。"
        paras = [text]
        chapters.append(Chapter(index=i, title=f"第{i + 1}章", text=text, paragraphs=paras))
    return chapters


def _real_style_chunks() -> list[str]:
    """真迹风格：短句、多对白、多叹号。"""
    return [
        f"“杀！”他拔剑。剑光如雪。血溅三尺。第{i}段，杀气冲天！"
        for i in range(8)
    ]


def _fake_style_chunks() -> list[str]:
    """仿造风格：长句、无对白、标点稀。"""
    return [
        f"夕阳缓慢地沉入远方的地平线，第{i}个黄昏如同之前无数个黄昏一样安静而漫长，旅人独自走着。"
        for i in range(8)
    ]


# ---------------------------------------------------------------------------
# 5.1 book_loader
# ---------------------------------------------------------------------------


def test_load_book_txt_utf8(tmp_path) -> None:
    p = tmp_path / "书.txt"
    p.write_text("第一章 开始\n\n这里是正文。", encoding="utf-8")
    assert "这里是正文。" in load_book(p)


def test_load_book_txt_gbk_fallback(tmp_path) -> None:
    p = tmp_path / "老书.txt"
    p.write_bytes("第一章 开始\n\n这里是正文。".encode("gbk"))
    assert "这里是正文。" in load_book(p)


def test_load_book_epub(tmp_path) -> None:
    """最小 epub：spine 顺序 c2→c1，验证按 OPF spine 而非文件名排序。"""
    p = tmp_path / "书.epub"
    container = (
        '<?xml version="1.0"?>'
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles></container>'
    )
    opf = (
        '<?xml version="1.0"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0">'
        "<manifest>"
        '<item id="c1" href="1.xhtml" media-type="application/xhtml+xml"/>'
        '<item id="c2" href="2.xhtml" media-type="application/xhtml+xml"/>'
        "</manifest>"
        '<spine><itemref idref="c2"/><itemref idref="c1"/></spine>'
        "</package>"
    )
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("META-INF/container.xml", container)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/1.xhtml", "<html><body><p>甲章内容</p></body></html>")
        z.writestr("OEBPS/2.xhtml", "<html><body><p>乙章内容</p></body></html>")
    text = load_book(p)
    assert "甲章内容" in text and "乙章内容" in text
    # spine 顺序 c2 在前
    assert text.index("乙章内容") < text.index("甲章内容")


def test_load_book_unsupported(tmp_path) -> None:
    with pytest.raises(ValueError):
        load_book(tmp_path / "书.pdf")


# ---------------------------------------------------------------------------
# 5.4 指纹增强
# ---------------------------------------------------------------------------


def test_stylometry_enhanced_fields() -> None:
    fp = compute_stylometry(_make_chapters())
    assert fp.metaphor_density > 0  # “仿佛”
    # “青冥” 只在 4 章中的前 2 章出现（df=50%），应入选签名用词
    assert "青冥" in fp.signature_words
    assert len(fp.signature_words) <= 20
    assert fp.forbidden_words == []


# ---------------------------------------------------------------------------
# 5.5 LLM 风格报告
# ---------------------------------------------------------------------------


async def test_llm_analyze_fallback_template(monkeypatch) -> None:
    """无模型（空串）时降级为统计模板，六个小节齐全。"""
    monkeypatch.setenv("NV_STYLE_LLM_MODEL", "")
    report = await llm_analyze(_make_chapters(), sample_size=2)
    assert report.summary
    for section in ("叙事视角", "节奏", "对白", "爽点", "用词", "禁忌"):
        assert section in report.sections
    assert "full" in report.sections


async def test_llm_analyze_llm_failure_fallback(monkeypatch) -> None:
    """LLM 调用失败同样降级，不抛异常。"""

    class _BadClient:
        async def chat(self, **kwargs):
            raise RuntimeError("connection refused")

    monkeypatch.setenv("NV_STYLE_LLM_MODEL", "some-model")
    report = await llm_analyze(_make_chapters(), 2, ollama_client=_BadClient())
    assert "full" in report.sections
    assert "节奏" in report.sections  # 模板小节


async def test_llm_analyze_with_fake_client() -> None:
    """有模型时解析模型输出的 markdown 二级标题。"""

    class _FakeClient:
        async def chat(self, model, messages):
            content = "# 风格指南\n\n## 节奏\n短句为主，很快。\n\n## 对白\n冷峻犀利。"
            return SimpleNamespace(message=SimpleNamespace(content=content))

    report = await llm_analyze(_make_chapters(), 2, ollama_client=_FakeClient(), model="m")
    assert report.sections["节奏"] == "短句为主，很快。"
    assert report.sections["对白"] == "冷峻犀利。"
    assert report.summary == "风格指南"
    assert report.sections["full"].startswith("# 风格指南")


# ---------------------------------------------------------------------------
# 5.6/5.7 判别器
# ---------------------------------------------------------------------------


def test_extract_style_features_dim() -> None:
    feats = extract_style_features("“走。”他拔剑。血溅！")
    assert len(feats) == STYLE_FEATURE_DIM
    assert all(isinstance(x, float) for x in feats)


def test_discriminator_train_and_score(tmp_path) -> None:
    disc = StyleDiscriminator(data_dir=tmp_path)
    real, fake = _real_style_chunks(), _fake_style_chunks()
    disc.train("s1", real, fake)
    assert disc.is_trained("s1")
    real_score = disc.score("s1", "“受死！”他出剑。快如闪电。血花飞溅！")
    fake_score = disc.score("s1", _fake_style_chunks()[0])
    assert real_score > fake_score
    assert real_score > 0.5
    # 持久化后新实例也能打分
    disc2 = StyleDiscriminator(data_dir=tmp_path)
    assert disc2.score("s1", "“受死！”他出剑。快如闪电。血花飞溅！") == pytest.approx(
        real_score
    )


def test_discriminator_auto_fake_samples(tmp_path) -> None:
    """fake 为空时自动从 real 生成扰动负样本，可正常训练。"""
    disc = StyleDiscriminator(data_dir=tmp_path)
    disc.train("s2", _real_style_chunks(), [])
    assert disc.is_trained("s2")
    assert 0.0 <= disc.score("s2", "“嗯。”他点头。转身离去。") <= 1.0


def test_discriminator_min_samples(tmp_path) -> None:
    disc = StyleDiscriminator(data_dir=tmp_path)
    too_few = _real_style_chunks()[: (MIN_TRAIN_SAMPLES // 2 - 1)]
    with pytest.raises(ValueError):
        disc.train("s3", too_few, [])


def test_discriminator_untrained_score_half(tmp_path) -> None:
    disc = StyleDiscriminator(data_dir=tmp_path)
    assert disc.score("不存在", "任意文本") == 0.5


# ---------------------------------------------------------------------------
# 5.6 流水线（注入 Mock 依赖，离线跑通七阶段）
# ---------------------------------------------------------------------------


async def test_analyzer_full_pipeline(tmp_path) -> None:
    book_a = _write_book(tmp_path / "书A.txt", "A")
    book_b = _write_book(tmp_path / "书B.txt", "B")
    store = ProfileStore(tmp_path / "data")
    vs = VectorStore()
    disc = StyleDiscriminator(tmp_path / "data")
    analyzer = StyleAnalyzer(
        embedder=MockEmbedder(), vector_store=vs, profile_store=store, discriminator=disc
    )

    frames = [
        f
        async for f in analyzer.analyze(
            "测试作家",
            [BookInput(title="书A", path=str(book_a)), BookInput(title="书B", path=str(book_b))],
            genre="武侠",
        )
    ]

    progress = [f for f in frames if isinstance(f, Progress)]
    done = [f for f in frames if isinstance(f, Done)]
    assert len(done) == 1
    # 七个阶段各推过进度
    for stage in PIPELINE_STAGES:
        assert any(f.stage == stage for f in progress), stage
    # 进度值域合法
    assert all(0.0 <= f.progress <= 1.0 for f in progress)

    payload = done[0].model_dump(by_alias=True)
    style_id = payload["styleId"]
    assert (tmp_path / "data" / "styles" / style_id / "report.md").exists()
    assert payload["reportPath"].endswith("report.md")

    # 档案可读回
    profile = store.get(style_id)
    assert profile is not None
    assert profile.author_name == "测试作家"
    assert profile.book_count == 2
    assert profile.fingerprint.metaphor_density > 0
    assert profile.report.sections  # 模板报告六节
    # RAG 入库统计与判别器
    assert vs.stats(style_id).total_chunks > 0
    assert disc.is_trained(style_id)
    assert profile.discriminator_version is not None
    # profile 字段带在 Done 里
    assert payload["profile"]["authorName"] == "测试作家"


# ---------------------------------------------------------------------------
# API 端到端：analyze(SSE) → get → delete
# ---------------------------------------------------------------------------


async def test_style_api_e2e(tmp_path) -> None:
    book = _write_book(tmp_path / "书X.txt", "X")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        async with client.stream(
            "POST",
            "/style/analyze",
            json={
                "authorName": "古龙",
                "genre": "武侠",
                "books": [{"title": "书X", "path": str(book)}],
            },
        ) as resp:
            assert resp.status_code == 200
            frames = [
                json.loads(line[len("data: "):])
                async for line in resp.aiter_lines()
                if line.startswith("data: ")
            ]
        assert frames[-1]["done"] is True
        style_id = frames[-1]["styleId"]

        get_resp = await client.get(f"/style/{style_id}")
        assert get_resp.status_code == 200
        body = get_resp.json()
        assert body["authorName"] == "古龙"
        assert body["genre"] == "武侠"
        assert body["bookCount"] == 1
        assert body["ragStats"]["totalChunks"] > 0
        assert body["fingerprint"]["metaphorDensity"] > 0

        del_resp = await client.delete(f"/style/{style_id}")
        assert del_resp.json()["ok"] is True
        assert (await client.get(f"/style/{style_id}")).status_code == 404
