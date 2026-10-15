"""场景分类 API：POST /scene/classify → { sceneType, confidence }。"""

from fastapi import APIRouter

from novel_forge_sidecar.models.schemas import (
    SceneClassifyRequest,
    SceneClassifyResponse,
)
from novel_forge_sidecar.services.scene_tagger import classify

router = APIRouter(prefix="/scene", tags=["scene"])


@router.post("/classify", response_model=SceneClassifyResponse)
async def scene_classify(req: SceneClassifyRequest) -> SceneClassifyResponse:
    """规则法场景分类（真实实现）。"""
    scene_type, confidence = classify(req.text)
    return SceneClassifyResponse(scene_type=scene_type, confidence=confidence)
