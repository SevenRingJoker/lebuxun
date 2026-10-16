"""全部 Pydantic v2 数据模型。

字段命名：Python 侧用 snake_case，线上协议与 TypeScript 类型（SPEC §6）保持一致，
序列化时通过 camelCase 别名输出。
"""

from __future__ import annotations

import time
import uuid
from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """基类：输出 camelCase 别名、允许按字段名填充。"""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
    )


class SceneType(str, Enum):
    """场景 8 类，取值与 SPEC §6.4 严格一致。"""

    BATTLE = "battle"
    DIALOGUE = "dialogue"
    DAILY = "daily"
    PSYCHOLOGY = "psychology"
    ENVIRONMENT = "environment"
    TRANSITION = "transition"
    HOOK = "hook"
    CLIMAX = "climax"


# ---------------------------------------------------------------------------
# 风格系统
# ---------------------------------------------------------------------------


class BookInput(CamelModel):
    """风格分析的输入书籍。"""

    title: str = ""
    path: str


class StyleBook(CamelModel):
    """StyleProfile 中登记的书籍。"""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    title: str
    word_count: Optional[int] = None
    chapter_count: Optional[int] = None
    path: Optional[str] = None


class StyleFingerprint(CamelModel):
    """风格指纹（SPEC §6.4）。"""

    avg_sentence_length: float = 0.0
    sentence_length_std: float = 0.0
    short_sentence_ratio: float = 0.0
    avg_paragraph_length: float = 0.0
    dialogue_ratio: float = 0.0
    metaphor_density: float = 0.0
    punctuation: dict[str, float] = Field(default_factory=dict)
    top_words: list[str] = Field(default_factory=list)
    signature_words: list[str] = Field(default_factory=list)
    forbidden_words: list[str] = Field(default_factory=list)


class StyleReport(CamelModel):
    """LLM 深度分析报告（Phase 1 占位，内容为 markdown 摘要 + 分节明细）。"""

    summary: str = ""
    sections: dict[str, str] = Field(default_factory=dict)


class RagStats(CamelModel):
    """RAG 库统计。"""

    total_chunks: int = 0
    by_scene: dict[str, int] = Field(default_factory=dict)


class StyleProfile(CamelModel):
    """风格档案（SPEC §6.4）。"""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    author_name: str
    genre: str = ""
    book_count: int = 0
    books: list[StyleBook] = Field(default_factory=list)
    fingerprint: StyleFingerprint = Field(default_factory=StyleFingerprint)
    report: StyleReport = Field(default_factory=StyleReport)
    rag_stats: RagStats = Field(default_factory=RagStats)
    discriminator_version: Optional[str] = None
    reward_model_version: Optional[str] = None
    created_at: int = Field(default_factory=lambda: int(time.time()))
    updated_at: int = Field(default_factory=lambda: int(time.time()))


# ---------------------------------------------------------------------------
# RAG
# ---------------------------------------------------------------------------


class RagChunk(CamelModel):
    """RAG 文本块（对应 SPEC §5.1 rag_chunks 表）。"""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    style_id: str
    book_id: str = ""
    chapter_index: int = 0
    text: str
    scene_type: SceneType = SceneType.DAILY


# ---------------------------------------------------------------------------
# 成长系统
# ---------------------------------------------------------------------------


class PreferenceSample(CamelModel):
    """偏好样本（SPEC §6.5）。"""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    project_id: str
    style_id: Optional[str] = None
    context: str
    chosen: str
    rejected: str
    reasons: list[str] = Field(default_factory=list)
    created_at: int = Field(default_factory=lambda: int(time.time()))


# ---------------------------------------------------------------------------
# SSE 进度协议
# ---------------------------------------------------------------------------


class Progress(CamelModel):
    """SSE 中间帧：{stage, progress}。"""

    stage: str
    progress: float


class Done(CamelModel):
    """SSE 结束帧：{done: true, ...}，允许携带任意附加字段。"""

    model_config = ConfigDict(extra="allow")

    done: bool = True


# ---------------------------------------------------------------------------
# API 请求 / 响应
# ---------------------------------------------------------------------------


class StyleAnalyzeRequest(CamelModel):
    author_name: str
    genre: str = ""
    books: list[BookInput]


class EmbedRequest(CamelModel):
    texts: list[str]


class EmbedResponse(CamelModel):
    vectors: list[list[float]]


class RagIndexRequest(CamelModel):
    style_id: str
    chunks: list[RagChunk]


class RagIndexResponse(CamelModel):
    ok: bool = True
    count: int


class RagQueryRequest(CamelModel):
    style_id: str
    query: str = ""
    scene_type: Optional[SceneType] = None
    top_k: int = 5


class RagQueryResponse(CamelModel):
    results: list[RagChunk]


class DiscriminatorScoreRequest(CamelModel):
    style_id: str
    text: str


class DiscriminatorScoreResponse(CamelModel):
    score: float
    verdict: str


class RewardScoreRequest(CamelModel):
    """打分请求：可直接传特征向量，或传 texts 由服务端提取特征（两者至少其一）。"""

    features: list[list[float]] = Field(default_factory=list)
    texts: Optional[list[str]] = None


class RewardScoreResponse(CamelModel):
    scores: list[float]
    model_version: Optional[str] = None


class RewardTrainRequest(CamelModel):
    samples: list[PreferenceSample]


class RewardStatusResponse(CamelModel):
    """奖励模型状态：版本 + 最近一次训练指标。未训练时全为 None。"""

    version: Optional[str] = None
    accuracy: Optional[float] = None
    kendall_tau: Optional[float] = None
    sample_count: Optional[int] = None
    trained_at: Optional[int] = None


# ---------------------------------------------------------------------------
# 演化模式学习 / 提示词进化（SPEC §10.4 / §10.5，任务 4.10 / 4.11）
# ---------------------------------------------------------------------------


class EvolutionTemplate(CamelModel):
    """改进模板：chosen vs rejected 特征差提炼出的规则。"""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    name: str
    description: str = ""
    instruction: str = ""
    feature_deltas: dict[str, float] = Field(default_factory=dict)
    support: int = 0
    confidence: float = 0.0
    created_at: int = Field(default_factory=lambda: int(time.time()))


class ExtractTemplatesRequest(CamelModel):
    samples: list[PreferenceSample]


class ExtractTemplatesResponse(CamelModel):
    templates: list[EvolutionTemplate]
    message: str = ""


class PromptTemplate(CamelModel):
    """提示词版本（SPEC §10.5）。"""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    node_type: str = "generate"
    project_id: Optional[str] = None
    version: int
    parent_version: Optional[int] = None
    content: str
    based_on: list[str] = Field(default_factory=list)
    created_at: int = Field(default_factory=lambda: int(time.time()))


class PromptTemplateCreateRequest(CamelModel):
    node_type: str = "generate"
    base_template: str
    project_id: Optional[str] = None


class PromptTemplateListResponse(CamelModel):
    templates: list[PromptTemplate]


class SceneClassifyRequest(CamelModel):
    text: str


class SceneClassifyResponse(CamelModel):
    scene_type: SceneType
    confidence: float


class LoraInferRequest(CamelModel):
    style_id: str
    prompt: str
    max_tokens: int = 512


class HealthResponse(CamelModel):
    status: str
    version: str


class OkResponse(CamelModel):
    ok: bool = True
