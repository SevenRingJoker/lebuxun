"""风格分析 API：/style/analyze(SSE)、/style/{styleId} 查询与删除。"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from novel_forge_sidecar.api.sse import sse_response
from novel_forge_sidecar.models.schemas import (
    OkResponse,
    StyleAnalyzeRequest,
    StyleProfile,
)
from novel_forge_sidecar.services import runtime
from novel_forge_sidecar.services.style_analyzer import StyleAnalyzer

router = APIRouter(prefix="/style", tags=["style"])

# 与 rag / embed 端点共享同一批运行时单例（见 services/runtime.py）
_analyzer = StyleAnalyzer()


@router.post("/analyze")
async def analyze(req: StyleAnalyzeRequest) -> StreamingResponse:
    """SSE 流式推进 7 阶段流水线。"""
    return sse_response(_analyzer.analyze(req.author_name, req.books, genre=req.genre))


@router.get("/{style_id}", response_model=StyleProfile)
async def get_style(style_id: str) -> StyleProfile:
    """查询风格档案；不存在返回 404。ragStats 实时取向量库统计。"""
    profile = runtime.get_profile_store().get(style_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="style not found")
    profile.rag_stats = runtime.get_vector_store().stats(style_id)
    return profile


@router.delete("/{style_id}", response_model=OkResponse)
async def delete_style(style_id: str) -> OkResponse:
    """删除风格档案：文件档案 + 向量行 + 判别器模型。"""
    runtime.get_profile_store().delete(style_id)
    runtime.get_vector_store().delete_style(style_id)
    runtime.get_discriminator().delete(style_id)
    return OkResponse()
