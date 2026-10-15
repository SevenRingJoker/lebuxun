"""Embedding API：POST /embed → { vectors }。

Phase 1 用 MockEmbedder（确定性伪随机向量），Ollama 可用后切换 OllamaEmbedder。
"""

from fastapi import APIRouter

from novel_forge_sidecar.models.schemas import EmbedRequest, EmbedResponse
from novel_forge_sidecar.services.embedder import MockEmbedder

router = APIRouter(tags=["embed"])

_embedder = MockEmbedder()


@router.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest) -> EmbedResponse:
    """批量计算文本向量。"""
    vectors = await _embedder.encode(req.texts)
    return EmbedResponse(vectors=vectors)
