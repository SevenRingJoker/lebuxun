"""风格分析器：SPEC §8.4 七阶段流水线真实实现（任务 5.6）。

阶段：chunking → cleaning → tagging → stylometry → llm-analysis
     → embedding → discriminator（语料足够时）

每阶段 yield Progress(stage, 0~1)，最后 yield Done（带 styleId / reportPath / profile）。
依赖全部走构造器注入（embedder / vector_store / profile_store / discriminator），
缺省从 services.runtime 取共享单例；embedder 缺省时由 runtime 探测
NV_OLLAMA_HOST 决定 OllamaEmbedder / MockEmbedder。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Optional, Union

from novel_forge_sidecar.models.schemas import (
    BookInput,
    Done,
    Progress,
    RagChunk,
    SceneType,
    StyleBook,
    StyleFingerprint,
    StyleProfile,
)
from novel_forge_sidecar.services import runtime
from novel_forge_sidecar.services.book_loader import load_book
from novel_forge_sidecar.services.discriminator import StyleDiscriminator
from novel_forge_sidecar.services.profile_store import ProfileStore
from novel_forge_sidecar.services.scene_tagger import classify
from novel_forge_sidecar.services.style_report import llm_analyze, select_sample_size
from novel_forge_sidecar.services.stylometry import compute_stylometry
from novel_forge_sidecar.services.vector_store import VectorStore
from novel_forge_sidecar.utils.text import Chapter, clean, quality_check, split_chapters

# SPEC §8.4 的阶段名
PIPELINE_STAGES = [
    "chunking",
    "cleaning",
    "tagging",
    "stylometry",
    "llm-analysis",
    "embedding",
    "discriminator",
]

# 语料不足时跳过判别器训练（对应 SPEC 自适应策略 N=1）
DISCRIMINATOR_MIN_CHAPTERS = 2


def build_rag_chunks(
    chapters: list[Chapter],
    fingerprint: StyleFingerprint,
    style_id: str,
) -> list[RagChunk]:
    """把章节段落展开成 RAG chunk（段落级，带 book_id / chapter_index / scene_type）。

    fingerprint 参数与 SPEC §8.4 签名对齐保留（后续可用于 chunk 元数据扩展）。
    """
    chunks: list[RagChunk] = []
    for ch in chapters:
        for i, para in enumerate(ch.paragraphs):
            scene = (
                SceneType(ch.scene_types[i])
                if i < len(ch.scene_types)
                else SceneType.DAILY
            )
            chunks.append(
                RagChunk(
                    style_id=style_id,
                    book_id=ch.book_id,
                    chapter_index=ch.index,
                    text=para,
                    scene_type=scene,
                )
            )
    return chunks


class StyleAnalyzer:
    """七阶段风格分析流水线。"""

    def __init__(
        self,
        embedder: Optional[runtime.Embedder] = None,
        vector_store: Optional[VectorStore] = None,
        profile_store: Optional[ProfileStore] = None,
        discriminator: Optional[StyleDiscriminator] = None,
        ollama_model: str = "",
    ) -> None:
        # embedder 为 None 时在 analyze 内懒解析（需 async 探测 Ollama）
        self._embedder = embedder
        self._vector_store = vector_store
        self._profile_store = profile_store
        self._discriminator = discriminator
        # 空串 = 读环境变量 NV_STYLE_LLM_MODEL；仍为空则跳过 LLM
        self._ollama_model = ollama_model

    async def _resolve_embedder(self) -> runtime.Embedder:
        if self._embedder is None:
            self._embedder = await runtime.get_embedder()
        return self._embedder

    # ------------------------------------------------------------------
    # 流水线
    # ------------------------------------------------------------------

    async def analyze(
        self,
        author_name: str,
        books: list[BookInput],
        genre: str = "",
    ) -> AsyncIterator[Union[Progress, Done]]:
        """执行七阶段流水线，逐阶段 yield Progress，最后 yield Done。"""
        vs = self._vector_store if self._vector_store is not None else runtime.get_vector_store()
        ps = (
            self._profile_store
            if self._profile_store is not None
            else runtime.get_profile_store()
        )
        disc = (
            self._discriminator
            if self._discriminator is not None
            else runtime.get_discriminator()
        )
        style_id = uuid.uuid4().hex

        # Stage 1: 结构化（加载 + 章节切分）
        yield Progress(stage="chunking", progress=0.0)
        chapters: list[Chapter] = []
        style_books: list[StyleBook] = []
        for i, book in enumerate(books):
            text = load_book(book.path)
            book_id = uuid.uuid4().hex
            book_chapters = split_chapters(text)
            for ch in book_chapters:
                ch.book_id = book_id
            chapters.extend(book_chapters)
            style_books.append(
                StyleBook(
                    id=book_id,
                    title=book.title or Path(book.path).stem,
                    word_count=len(text),
                    chapter_count=len(book_chapters),
                    path=book.path,
                )
            )
            yield Progress(stage="chunking", progress=(i + 1) / max(len(books), 1))
        yield Progress(stage="chunking", progress=1.0)
        if not chapters:
            raise ValueError("未从书籍中切分出任何章节")

        # Stage 2: 清洗（去广告水印 + 质量过滤）
        yield Progress(stage="cleaning", progress=0.0)
        cleaned: list[Chapter] = []
        for i, ch in enumerate(chapters):
            text = clean(ch.text)
            if quality_check(text):
                paragraphs = [p for p in text.split("\n") if p.strip()]
                cleaned.append(
                    Chapter(
                        index=ch.index,
                        title=ch.title,
                        text=text,
                        paragraphs=paragraphs,
                        book_id=ch.book_id,
                    )
                )
            yield Progress(stage="cleaning", progress=(i + 1) / len(chapters))
        chapters = cleaned
        yield Progress(stage="cleaning", progress=1.0)
        if not chapters:
            raise ValueError("清洗后无有效章节")

        # Stage 3: 场景标注（段落级规则分类）
        yield Progress(stage="tagging", progress=0.0)
        for i, ch in enumerate(chapters):
            ch.scene_types = [classify(p)[0].value for p in ch.paragraphs]
            yield Progress(stage="tagging", progress=(i + 1) / len(chapters))
        yield Progress(stage="tagging", progress=1.0)

        # Stage 4: 统计特征
        yield Progress(stage="stylometry", progress=0.0)
        fingerprint = compute_stylometry(chapters)
        yield Progress(stage="stylometry", progress=1.0)

        # Stage 5: LLM 深度分析（无模型时降级为统计模板）
        yield Progress(stage="llm-analysis", progress=0.0)
        report = await llm_analyze(
            chapters,
            sample_size=select_sample_size(len(chapters)),
            model=self._ollama_model,
        )
        yield Progress(stage="llm-analysis", progress=1.0)

        # Stage 6: Embedding + 入库
        yield Progress(stage="embedding", progress=0.0)
        chunks = build_rag_chunks(chapters, fingerprint, style_id)
        embedder = await self._resolve_embedder()
        vectors = await embedder.encode([c.text for c in chunks])
        vs.upsert(style_id, chunks, vectors)
        yield Progress(stage="embedding", progress=1.0)

        # Stage 7: 训练判别器（语料足够时）
        discriminator_version: Optional[str] = None
        if len(chapters) >= DISCRIMINATOR_MIN_CHAPTERS:
            yield Progress(stage="discriminator", progress=0.0)
            real_chunks = [p for ch in chapters for p in ch.paragraphs]
            try:
                disc.train(style_id, real_chunks, [])
                discriminator_version = "v1"
            except ValueError:
                # 有效样本不足（段落太少），跳过训练不阻断流水线
                pass
            yield Progress(stage="discriminator", progress=1.0)

        profile = StyleProfile(
            id=style_id,
            author_name=author_name,
            genre=genre,
            book_count=len(style_books),
            books=style_books,
            fingerprint=fingerprint,
            report=report,
            rag_stats=vs.stats(style_id),
            discriminator_version=discriminator_version,
        )
        report_path = ps.save(profile)

        yield Done.model_validate(
            {
                "styleId": style_id,
                "reportPath": str(report_path),
                "profile": profile.model_dump(by_alias=True, mode="json"),
            }
        )
