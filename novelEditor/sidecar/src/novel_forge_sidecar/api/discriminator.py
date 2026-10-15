"""风格判别器 API：POST /discriminator/score → { score, verdict }。"""

from fastapi import APIRouter

from novel_forge_sidecar.models.schemas import (
    DiscriminatorScoreRequest,
    DiscriminatorScoreResponse,
)
from novel_forge_sidecar.services.discriminator import StyleDiscriminator

router = APIRouter(prefix="/discriminator", tags=["discriminator"])

_discriminator = StyleDiscriminator()


@router.post("/score", response_model=DiscriminatorScoreResponse)
async def score(req: DiscriminatorScoreRequest) -> DiscriminatorScoreResponse:
    """判别文本是否出自目标作家风格。Phase 1 恒返回 0.5 / unknown。"""
    s = _discriminator.score(req.style_id, req.text)
    verdict = "unknown"
    if s >= 0.7:
        verdict = "authentic"
    elif s <= 0.3:
        verdict = "mismatch"
    return DiscriminatorScoreResponse(score=s, verdict=verdict)
