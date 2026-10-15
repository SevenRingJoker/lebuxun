"""奖励模型 API：POST /reward/score、POST /reward/train(SSE)。"""

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from novel_forge_sidecar.api.sse import sse_response
from novel_forge_sidecar.models.schemas import (
    RewardScoreRequest,
    RewardScoreResponse,
    RewardTrainRequest,
)
from novel_forge_sidecar.services.reward_model import RewardModel

router = APIRouter(prefix="/reward", tags=["reward"])

_model = RewardModel()


@router.post("/score", response_model=RewardScoreResponse)
async def score(req: RewardScoreRequest) -> RewardScoreResponse:
    """对候选特征批量打分（mock 恒 0.5）。"""
    return RewardScoreResponse(scores=_model.score(req.features))


@router.post("/train")
async def train(req: RewardTrainRequest) -> StreamingResponse:
    """SSE 流式训练进度（mock）。"""
    return sse_response(_model.train_stream(req.samples))
