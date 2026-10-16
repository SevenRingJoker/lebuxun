"""演化 API（SPEC §10.4 / §10.5）：模板提取与提示词版本管理。"""

from fastapi import APIRouter

from novel_forge_sidecar.models.schemas import (
    ExtractTemplatesRequest,
    ExtractTemplatesResponse,
    PromptTemplate,
    PromptTemplateCreateRequest,
    PromptTemplateListResponse,
)
from novel_forge_sidecar.services.evolution import EvolutionLearner
from novel_forge_sidecar.services.prompt_evolver import PromptEvolver

router = APIRouter(prefix="/evolution", tags=["evolution"])

_learner = EvolutionLearner()
_evolver = PromptEvolver(evolution_learner=_learner)


@router.post("/extract-templates", response_model=ExtractTemplatesResponse)
async def extract_templates(req: ExtractTemplatesRequest) -> ExtractTemplatesResponse:
    """从成对偏好样本提取改进模板（任务 4.10）。样本不足返回空列表 + 提示。"""
    templates, message = _learner.extract_templates(req.samples)
    return ExtractTemplatesResponse(templates=templates, message=message)


@router.get("/prompt-templates", response_model=PromptTemplateListResponse)
async def list_prompt_templates(nodeType: str | None = None) -> PromptTemplateListResponse:
    """列出提示词模板全部版本（任务 4.11），可按 nodeType 过滤。"""
    return PromptTemplateListResponse(templates=_evolver.list_templates(nodeType))


@router.post("/prompt-templates", response_model=PromptTemplate)
async def create_prompt_template(req: PromptTemplateCreateRequest) -> PromptTemplate:
    """基于基础模板 + 演化模板生成新版本，版本号递增（任务 4.11）。"""
    return _evolver.create_version(
        base_template=req.base_template,
        node_type=req.node_type,
        project_id=req.project_id,
    )
