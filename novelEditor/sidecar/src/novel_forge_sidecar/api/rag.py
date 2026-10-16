"""RAG API：POST /rag/index、POST /rag/query。

向量库与 Embedder 走 services/runtime 共享单例，
与 /style/analyze 流水线写入的索引互通。
"""

from fastapi import APIRouter

from novel_forge_sidecar.models.schemas import (
    RagIndexRequest,
    RagIndexResponse,
    RagQueryRequest,
    RagQueryResponse,
)
from novel_forge_sidecar.services import runtime

router = APIRouter(prefix="/rag", tags=["rag"])


@router.post("/index", response_model=RagIndexResponse)
async def index(req: RagIndexRequest) -> RagIndexResponse:
    """为一组 chunk 计算向量并入库。"""
    embedder = await runtime.get_embedder()
    vectors = await embedder.encode([c.text for c in req.chunks])
    runtime.get_vector_store().upsert(req.style_id, req.chunks, vectors)
    return RagIndexResponse(ok=True, count=len(req.chunks))


@router.post("/query", response_model=RagQueryResponse)
async def query(req: RagQueryRequest) -> RagQueryResponse:
    """向量检索 top_k。空库时返回空结果。"""
    if not req.query:
        return RagQueryResponse(results=[])
    embedder = await runtime.get_embedder()
    [qv] = await embedder.encode([req.query])
    results = runtime.get_vector_store().query(req.style_id, qv, req.scene_type, req.top_k)
    return RagQueryResponse(results=results)
