"""运行时共享单例：数据目录、档案库、向量库、Embedder、判别器。

api/style、api/rag、api/embed、api/discriminator 必须共享同一份
VectorStore / Embedder，否则风格流水线建的索引对检索端点不可见。

Embedder 选择策略：对 NV_OLLAMA_HOST 做一次带短超时的健康探测，
可用则 OllamaEmbedder，否则回退 MockEmbedder（离线可跑）。
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Optional, Union

from novel_forge_sidecar.services.discriminator import StyleDiscriminator
from novel_forge_sidecar.services.embedder import MockEmbedder, OllamaEmbedder
from novel_forge_sidecar.services.profile_store import ProfileStore
from novel_forge_sidecar.services.vector_store import VectorStore

ENV_DATA_DIR = "NV_DATA_DIR"
ENV_OLLAMA_HOST = "NV_OLLAMA_HOST"
_DEFAULT_OLLAMA_HOST = "http://localhost:11434"
# Ollama 健康探测超时（秒），失败回退 Mock
_PROBE_TIMEOUT = 2.0

Embedder = Union[OllamaEmbedder, MockEmbedder]


def data_dir() -> Path:
    """数据根目录：环境变量 NV_DATA_DIR，缺省 ./data。"""
    return Path(os.environ.get(ENV_DATA_DIR, "./data"))


_profile_store: Optional[ProfileStore] = None
_vector_store: Optional[VectorStore] = None
_discriminator: Optional[StyleDiscriminator] = None
_embedder: Optional[Embedder] = None


def get_profile_store() -> ProfileStore:
    global _profile_store
    if _profile_store is None:
        _profile_store = ProfileStore(data_dir())
    return _profile_store


def get_vector_store() -> VectorStore:
    """文件持久化的共享向量库（data/rag.sqlite3）。"""
    global _vector_store
    if _vector_store is None:
        data_dir().mkdir(parents=True, exist_ok=True)
        _vector_store = VectorStore(str(data_dir() / "rag.sqlite3"))
    return _vector_store


def get_discriminator() -> StyleDiscriminator:
    global _discriminator
    if _discriminator is None:
        _discriminator = StyleDiscriminator(data_dir())
    return _discriminator


async def get_embedder() -> Embedder:
    """探测 Ollama：可用返回 OllamaEmbedder，否则 MockEmbedder（只探测一次并缓存）。"""
    global _embedder
    if _embedder is not None:
        return _embedder
    candidate = OllamaEmbedder(host=os.environ.get(ENV_OLLAMA_HOST, _DEFAULT_OLLAMA_HOST))
    try:
        await asyncio.wait_for(candidate.encode(["健康探测"]), timeout=_PROBE_TIMEOUT)
        _embedder = candidate
    except Exception:
        _embedder = MockEmbedder()
    return _embedder


def reset_for_testing() -> None:
    """测试用：清空全部单例缓存（下次访问时按当前环境变量重建）。"""
    global _profile_store, _vector_store, _discriminator, _embedder
    _profile_store = None
    _vector_store = None
    _discriminator = None
    _embedder = None
