"""Embedding 服务。

- OllamaEmbedder：SPEC §8.2 的真实实现，走 Ollama 原生 /api/embed。
- MockEmbedder：Phase 1 默认使用，伪随机但确定性（hash 做种子），无需 Ollama 在线。
"""

from __future__ import annotations

import hashlib

import numpy as np
from ollama import AsyncClient

# 向量维度，与 nomic-embed-text 对齐
EMBEDDING_DIM = 768


class OllamaEmbedder:
    """SPEC §8.2：Ollama 原生批量 embed。"""

    def __init__(
        self,
        host: str = "http://localhost:11434",
        model: str = "nomic-embed-text",
        batch_size: int = 32,
    ) -> None:
        self.client = AsyncClient(host=host)
        self.model = model
        self.batch_size = batch_size

    async def encode(self, texts: list[str]) -> list[list[float]]:
        """按 batch_size 分批请求 Ollama，返回向量列表。"""
        all_vectors: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            res = await self.client.embed(model=self.model, input=batch)
            all_vectors.extend([list(v) for v in res.embeddings])
        return all_vectors


class MockEmbedder:
    """Phase 1 mock：用文本 sha256 做随机种子，生成确定性单位向量。"""

    def __init__(self, dim: int = EMBEDDING_DIM) -> None:
        self.dim = dim

    async def encode(self, texts: list[str]) -> list[list[float]]:
        """同一文本永远得到同一向量，便于测试与缓存验证。"""
        return [self._embed_one(t) for t in texts]

    def _embed_one(self, text: str) -> list[float]:
        seed = int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        vec = rng.standard_normal(self.dim)
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        return [float(x) for x in vec]
