"""RAG API：POST /rag/index、POST /rag/query。"""

from fastapi import APIRouter

from novel_forge_sidecar.models.schemas import (
    RagIndexRequest,
    RagIndexResponse,
    RagQueryRequest,
    RagQueryResponse,
)
from novel_forge_sidecar.services.embedder import MockEmbedder
from novel_forge_sidecar.services.vector_store import VectorStore

router = APIRouter(prefix="/rag", tags=["rag"])

_store = VectorStore()
_embedder = MockEmbedder()


@router.post("/index", response_model=RagIndexResponse)
async def index(req: RagIndexRequest) -> RagIndexResponse:
    """为一组 chunk 计算向量并入库。"""
    vectors = await _embedder.encode([c.text for c in req.chunks])
    _store.upsert(req.style_id, req.chunks, vectors)
    return RagIndexResponse(ok=True, count=len(req.chunks))


@router.post("/query", response_model=RagQueryResponse)
async def query(req: RagQueryRequest) -> RagQueryResponse:
    """向量检索 top_k。Phase 1 空库时返回空结果。"""
    if not req.query:
        return RagQueryResponse(results=[])
    [qv] = await _embedder.encode([req.query])
    results = _store.query(req.style_id, qv, req.scene_type, req.top_k)
    return RagQueryResponse(results=results)
