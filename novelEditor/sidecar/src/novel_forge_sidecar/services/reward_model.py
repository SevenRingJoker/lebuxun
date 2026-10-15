"""奖励模型（SPEC §8.6）。Phase 1 mock 实现。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Union

from novel_forge_sidecar.models.schemas import Done, PreferenceSample, Progress


class RewardModel:
    """接口骨架：train / score。"""

    def __init__(self) -> None:
        self._sample_count = 0

    def score(self, features: list[list[float]]) -> list[float]:
        """mock：每个特征向量给一个确定性的 0.5 分。"""
        return [0.5 for _ in features]

    async def train_stream(
        self, samples: list[PreferenceSample]
    ) -> AsyncIterator[Union[Progress, Done]]:
        """mock 训练流：按 epoch 推进度（api 层负责 sleep 节流）。"""
        import asyncio

        epochs = 5
        for i in range(epochs):
            yield Progress(stage="train", progress=(i + 1) / epochs)
            await asyncio.sleep(0.1)
        self._sample_count += len(samples)
        yield Done.model_validate({"sampleCount": len(samples), "version": "mock-v1"})
