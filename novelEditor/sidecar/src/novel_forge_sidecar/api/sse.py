"""SSE 流式响应工具。

协议（SPEC §4.2）：Content-Type: text/event-stream，
每帧 `data: {json}\\n\\n`，中间帧 Progress，最后一帧 {done: true, ...}。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Union

from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from novel_forge_sidecar.models.schemas import Done, Progress


def _format_frame(payload: BaseModel) -> str:
    """把模型序列化成一帧 SSE data 行。"""
    return f"data: {payload.model_dump_json(by_alias=True)}\n\n"


async def _wrap_stream(
    stream: AsyncIterator[Union[Progress, Done]],
) -> AsyncIterator[str]:
    async for item in stream:
        yield _format_frame(item)


def sse_response(stream: AsyncIterator[Union[Progress, Done]]) -> StreamingResponse:
    """把 Progress/Done 异步生成器包装成 SSE 响应。"""
    return StreamingResponse(
        _wrap_stream(stream),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # 禁用反向代理缓冲
        },
    )
