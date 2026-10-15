"""LoRA 推理 API：POST /lora/infer（SSE 流式，Phase 3+ 启用，当前为 mock 占位）。"""

import asyncio
from collections.abc import AsyncIterator
from typing import Union

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from novel_forge_sidecar.api.sse import sse_response
from novel_forge_sidecar.models.schemas import Done, LoraInferRequest, Progress

router = APIRouter(prefix="/lora", tags=["lora"])


async def _mock_infer(req: LoraInferRequest) -> AsyncIterator[Union[Progress, Done]]:
    """mock：loading → generating 两阶段推少量进度，最后返回占位文本。"""
    yield Progress(stage="loading", progress=0.0)
    await asyncio.sleep(0.1)
    yield Progress(stage="loading", progress=1.0)
    for i in range(3):
        await asyncio.sleep(0.1)
        yield Progress(stage="generating", progress=(i + 1) / 3)
    yield Done.model_validate({"text": f"[mock LoRA output for: {req.prompt[:32]}]"})


@router.post("/infer")
async def infer(req: LoraInferRequest) -> StreamingResponse:
    """SSE 流式 LoRA 推理（mock）。"""
    return sse_response(_mock_infer(req))
