"""风格判别器（SPEC §8.5）。Phase 1 mock 实现。"""

from __future__ import annotations


class StyleDiscriminator:
    """接口骨架：train / score。mock 状态下 score 恒返回 0.5。"""

    def __init__(self) -> None:
        # style_id -> 是否已训练
        self._trained: dict[str, bool] = {}

    def train(self, style_id: str, real_chunks: list[str], fake_chunks: list[str]) -> None:
        """mock：仅记录已训练标记。"""
        self._trained[style_id] = True

    def score(self, style_id: str, text: str) -> float:
        """mock：返回 0.5（unknown），表示判别器尚未具备判断能力。"""
        return 0.5
