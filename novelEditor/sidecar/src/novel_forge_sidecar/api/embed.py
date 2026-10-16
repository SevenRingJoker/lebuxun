"""Embedding API：POST /embed → { vectors }。

Embedder 走 services/runtime 共享单例：Ollama 可用时用真实模型，
否则回退 MockEmbedder（确定性伪随机向量）。
"""

from fastapi import APIRouter

from novel_forge_sidecar.models.schemas import EmbedRequest, EmbedResponse
from novel_forge_sidecar.services import runtime

router = APIRouter(tags=["embed"])


@router.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest) -> EmbedResponse:
    """批量计算文本向量。"""
    embedder = await runtime.get_embedder()
    vectors = await embedder.encode(req.texts)
    return EmbedResponse(vectors=vectors)
