"""风格分析器：SPEC §8.4 七阶段流水线骨架（Phase 1 mock 数据流）。

阶段：chunking → cleaning → tagging → stylometry → llm-analysis
     → embedding → discriminator（语料足够时）
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Union

from novel_forge_sidecar.models.schemas import (
    BookInput,
    Done,
    Progress,
)

# SPEC §8.4 的阶段名
PIPELINE_STAGES = [
    "chunking",
    "cleaning",
    "tagging",
    "stylometry",
    "llm-analysis",
    "embedding",
    "discriminator",
]

# 语料不足时跳过判别器训练（对应 SPEC 自适应策略 N=1）
DISCRIMINATOR_MIN_CHAPTERS = 2


class StyleAnalyzer:
    """接口骨架：analyze 为异步生成器，逐阶段 yield Progress，最后 yield Done。"""

    async def analyze(
        self,
        author_name: str,
        books: list[BookInput],
    ) -> AsyncIterator[Union[Progress, Done]]:
        """7 阶段流水线 mock：每阶段从 0 → 1 推一次进度，阶段间 sleep 模拟耗时。"""
        for stage in PIPELINE_STAGES:
            yield Progress(stage=stage, progress=0.0)
            await asyncio.sleep(0.1)
            yield Progress(stage=stage, progress=1.0)
        style_id = uuid.uuid4().hex
        # extra="allow"，附加字段经 model_validate 注入
        yield Done.model_validate(
            {"styleId": style_id, "reportPath": f"data/styles/{style_id}/report.md"}
        )
