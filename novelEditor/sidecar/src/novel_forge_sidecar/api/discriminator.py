"""风格判别器 API：POST /discriminator/score → { score, verdict }。"""

from fastapi import APIRouter

from novel_forge_sidecar.models.schemas import (
    DiscriminatorScoreRequest,
    DiscriminatorScoreResponse,
)
from novel_forge_sidecar.services import runtime

router = APIRouter(prefix="/discriminator", tags=["discriminator"])


@router.post("/score", response_model=DiscriminatorScoreResponse)
async def score(req: DiscriminatorScoreRequest) -> DiscriminatorScoreResponse:
    """判别文本是否出自目标作家风格；未训练的风格返回 0.5 / unknown。"""
    s = runtime.get_discriminator().score(req.style_id, req.text)
    verdict = "unknown"
    if s >= 0.7:
        verdict = "authentic"
    elif s <= 0.3:
        verdict = "mismatch"
    return DiscriminatorScoreResponse(score=s, verdict=verdict)
