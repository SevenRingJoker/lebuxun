"""奖励模型 API：POST /reward/score、POST /reward/train(SSE)、GET /reward/status。"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from novel_forge_sidecar.api.sse import sse_response
from novel_forge_sidecar.models.schemas import (
    RewardScoreRequest,
    RewardScoreResponse,
    RewardStatusResponse,
    RewardTrainRequest,
)
from novel_forge_sidecar.services.reward_model import MIN_TRAIN_SAMPLES, RewardModel

router = APIRouter(prefix="/reward", tags=["reward"])

_model = RewardModel()


@router.post("/score", response_model=RewardScoreResponse)
async def score(req: RewardScoreRequest) -> RewardScoreResponse:
    """对候选打分：传 texts 由服务端提特征，或传预计算 features；无模型时回退启发式。"""
    scores = (
        _model.score_texts(req.texts)
        if req.texts is not None
        else _model.score(req.features)
    )
    return RewardScoreResponse(scores=scores, model_version=_model.version)


@router.post("/train")
async def train(req: RewardTrainRequest) -> StreamingResponse:
    """SSE 流式训练。样本数 < 100 时拒绝并返回明确错误。"""
    if len(req.samples) < MIN_TRAIN_SAMPLES:
        raise HTTPException(
            status_code=400,
            detail=f"训练样本不足：当前 {len(req.samples)} 条，需要至少 {MIN_TRAIN_SAMPLES} 条",
        )
    return sse_response(_model.train_stream(req.samples))


@router.get("/status", response_model=RewardStatusResponse)
async def status() -> RewardStatusResponse:
    """查询当前奖励模型版本与最近一次训练指标；未训练时全字段为 null。"""
    return RewardStatusResponse(**_model.status())
