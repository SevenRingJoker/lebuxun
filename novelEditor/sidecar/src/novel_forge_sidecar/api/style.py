"""风格分析 API：/style/analyze(SSE)、/style/{styleId} 查询与删除。"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from novel_forge_sidecar.api.sse import sse_response
from novel_forge_sidecar.models.schemas import (
    OkResponse,
    StyleAnalyzeRequest,
    StyleProfile,
)
from novel_forge_sidecar.services.style_analyzer import StyleAnalyzer

router = APIRouter(prefix="/style", tags=["style"])

_analyzer = StyleAnalyzer()

# Phase 1 进程内存档，后续迁移到 SQLite styles 表
_profiles: dict[str, StyleProfile] = {}


@router.post("/analyze")
async def analyze(req: StyleAnalyzeRequest) -> StreamingResponse:
    """SSE 流式推进 7 阶段流水线（mock）。"""
    return sse_response(_analyzer.analyze(req.author_name, req.books))


@router.get("/{style_id}", response_model=StyleProfile)
async def get_style(style_id: str) -> StyleProfile:
    """查询风格档案；不存在返回 404。"""
    profile = _profiles.get(style_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="style not found")
    return profile


@router.delete("/{style_id}", response_model=OkResponse)
async def delete_style(style_id: str) -> OkResponse:
    """删除风格档案（mock：无论是否存在都返回 ok）。"""
    _profiles.pop(style_id, None)
    return OkResponse()
