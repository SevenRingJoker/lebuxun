"""健康检查：GET /health → { status, version }。"""

from fastapi import APIRouter

from novel_forge_sidecar import __version__
from novel_forge_sidecar.models.schemas import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Main 进程启动后以此探测 sidecar 就绪。"""
    return HealthResponse(status="ok", version=__version__)
