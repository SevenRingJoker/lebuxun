"""奖励模型（SPEC §8.6 / 任务 4.9）。

轻量实现（numpy 手写，不引 torch / sklearn）：
- 特征：text_features.extract_features（手工特征 + 哈希 bigram 投影）；
- 模型：成对偏好差分上的逻辑回归（chosen - rejected → 1），梯度下降训练；
- 持久化：models/reward/{version}.npz + latest.json 指针；
- 评估：留出 20% 验证集，输出成对准确率与 Kendall tau。

SSE 训练流阶段：feature-extraction → training → evaluating → done。
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Optional, Union

import numpy as np

from novel_forge_sidecar.models.schemas import Done, PreferenceSample, Progress
from novel_forge_sidecar.services.text_features import FEATURE_DIM, extract_features

# 训练所需的最小样本数（SPEC §14 任务 4.9：100 样本后能训练）
MIN_TRAIN_SAMPLES = 100
# 留出验证集比例
VAL_RATIO = 0.2
# 默认模型目录：sidecar/models/reward
_DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[3] / "models" / "reward"

# 无模型时的启发式 baseline 权重（作用在原始特征前若干维上的固定小权重）
_HEURISTIC_WEIGHTS = np.array(
    [0.05, 0.02, -0.005, 0.01, -0.01, 0.3, 0.8, 0.0, 0.4, 0.15, 0.2]
    + [0.0] * (FEATURE_DIM - 11)
)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def _kendall_tau(scores: np.ndarray, labels: np.ndarray) -> float:
    """Kendall tau-b 简化版：忽略 label 相同对（此处 label 全异），统计 concordant/discordant。"""
    n = len(scores)
    concordant = discordant = 0
    for i in range(n):
        for j in range(i + 1, n):
            ds = scores[i] - scores[j]
            dl = labels[i] - labels[j]
            prod = ds * dl
            if prod > 0:
                concordant += 1
            elif prod < 0:
                discordant += 1
    total = concordant + discordant
    return (concordant - discordant) / total if total else 0.0


class RewardModel:
    """成对偏好逻辑回归奖励模型。"""

    def __init__(self, model_dir: Optional[Path] = None) -> None:
        self._model_dir = Path(model_dir) if model_dir else _DEFAULT_MODEL_DIR
        self._weights: Optional[np.ndarray] = None
        self._bias: float = 0.0
        self._mean: Optional[np.ndarray] = None
        self._std: Optional[np.ndarray] = None
        self._version: Optional[str] = None
        # 最近一次训练指标（来自 latest.json，未训练 / 老格式指针时为 None）
        self._accuracy: Optional[float] = None
        self._kendall_tau: Optional[float] = None
        self._sample_count: Optional[int] = None
        self._trained_at: Optional[int] = None
        self._load_latest()

    # ------------------------------------------------------------------
    # 持久化
    # ------------------------------------------------------------------

    @property
    def version(self) -> Optional[str]:
        return self._version

    def _latest_pointer(self) -> Path:
        return self._model_dir / "latest.json"

    def _next_version(self) -> str:
        existing = [p.stem for p in self._model_dir.glob("v*.npz")] if self._model_dir.exists() else []
        nums = [int(s[1:]) for s in existing if s[1:].isdigit()]
        return f"v{(max(nums) + 1) if nums else 1}"

    def _load_latest(self) -> None:
        """加载 latest 指针指向的模型；不存在则保持无模型状态。"""
        pointer = self._latest_pointer()
        if not pointer.exists():
            return
        try:
            meta = json.loads(pointer.read_text(encoding="utf-8"))
            path = self._model_dir / f"{meta['version']}.npz"
            data = np.load(path)
            self._weights = data["weights"]
            self._bias = float(data["bias"])
            self._mean = data["mean"]
            self._std = data["std"]
            self._version = str(meta["version"])
            # 训练指标为可选字段：老格式 latest.json 只有 version，容错读为 None
            self._accuracy = (
                float(meta["accuracy"]) if meta.get("accuracy") is not None else None
            )
            self._kendall_tau = (
                float(meta["kendallTau"]) if meta.get("kendallTau") is not None else None
            )
            self._sample_count = (
                int(meta["sampleCount"]) if meta.get("sampleCount") is not None else None
            )
            self._trained_at = (
                int(meta["trainedAt"]) if meta.get("trainedAt") is not None else None
            )
        except (OSError, KeyError, ValueError, json.JSONDecodeError):
            self._weights = None  # 损坏时回退启发式

    def _save(
        self,
        *,
        accuracy: Optional[float] = None,
        kendall_tau: Optional[float] = None,
        sample_count: Optional[int] = None,
    ) -> str:
        """保存当前模型并把版本号 + 训练指标写入 latest 指针，返回版本号。"""
        assert self._weights is not None and self._mean is not None and self._std is not None
        self._model_dir.mkdir(parents=True, exist_ok=True)
        version = self._next_version()
        np.savez(
            self._model_dir / f"{version}.npz",
            weights=self._weights,
            bias=np.float64(self._bias),
            mean=self._mean,
            std=self._std,
            meta=np.array(json.dumps({"featureDim": FEATURE_DIM, "createdAt": int(time.time())})),
        )
        trained_at = int(time.time())
        pointer = {
            "version": version,
            "accuracy": accuracy,
            "kendallTau": kendall_tau,
            "sampleCount": sample_count,
            "trainedAt": trained_at,
        }
        self._latest_pointer().write_text(
            json.dumps(pointer, ensure_ascii=False), encoding="utf-8"
        )
        self._version = version
        self._accuracy = accuracy
        self._kendall_tau = kendall_tau
        self._sample_count = sample_count
        self._trained_at = trained_at
        return version

    def status(self) -> dict:
        """当前奖励模型状态：未训练时 version 为 None、指标全为 None。"""
        return {
            "version": self._version,
            "accuracy": self._accuracy,
            "kendallTau": self._kendall_tau,
            "sampleCount": self._sample_count,
            "trainedAt": self._trained_at,
        }

    # ------------------------------------------------------------------
    # 打分
    # ------------------------------------------------------------------

    def _align_dim(self, features: list[float]) -> np.ndarray:
        """外部传入的任意长度特征向量对齐到 FEATURE_DIM（截断 / 零填充）。"""
        vec = np.zeros(FEATURE_DIM, dtype=np.float64)
        src = np.asarray(features, dtype=np.float64)[:FEATURE_DIM]
        vec[: len(src)] = src
        return vec

    def score(self, features: list[list[float]]) -> list[float]:
        """对特征向量批量打分。有模型走模型，无模型回退启发式 baseline。"""
        if not features:
            return []
        mat = np.stack([self._align_dim(f) for f in features])
        if self._weights is not None and self._mean is not None and self._std is not None:
            normed = (mat - self._mean) / self._std
            return _sigmoid(normed @ self._weights + self._bias).tolist()
        return _sigmoid(mat @ _HEURISTIC_WEIGHTS).tolist()

    def score_texts(self, texts: list[str]) -> list[float]:
        """直接对文本打分（服务端提取特征），供 Main 侧免特征工程调用。"""
        return self.score([extract_features(t).tolist() for t in texts])

    # ------------------------------------------------------------------
    # 训练
    # ------------------------------------------------------------------

    def _train_pairwise(self, feats_chosen: np.ndarray, feats_rejected: np.ndarray) -> None:
        """在差分特征上做逻辑回归（y 恒为 1，即 chosen 应得分更高），并做特征标准化。"""
        all_feats = np.concatenate([feats_chosen, feats_rejected], axis=0)
        self._mean = all_feats.mean(axis=0)
        std = all_feats.std(axis=0)
        std[std < 1e-8] = 1.0  # 常数维度防除零
        self._std = std

        diffs = (feats_chosen - feats_rejected) / self._std  # 差分用同一标准化
        n = len(diffs)
        w = np.zeros(FEATURE_DIM, dtype=np.float64)
        b = 0.0
        lr, l2, epochs = 0.5, 1e-3, 300
        for _ in range(epochs):
            p = _sigmoid(diffs @ w + b)
            grad_w = diffs.T @ (p - 1.0) / n + l2 * w
            grad_b = float((p - 1.0).mean())
            w -= lr * grad_w
            b -= lr * grad_b
        self._weights = w
        self._bias = b

    def _raw_score(self, feats: np.ndarray) -> np.ndarray:
        assert self._weights is not None and self._mean is not None and self._std is not None
        return _sigmoid((feats - self._mean) / self._std @ self._weights + self._bias)

    async def train_stream(
        self, samples: list[PreferenceSample]
    ) -> AsyncIterator[Union[Progress, Done]]:
        """SSE 训练流：feature-extraction → training → evaluating → done。"""
        yield Progress(stage="feature-extraction", progress=0.0)
        chosen = np.stack([extract_features(s.chosen) for s in samples])
        rejected = np.stack([extract_features(s.rejected) for s in samples])
        await asyncio.sleep(0)
        yield Progress(stage="feature-extraction", progress=1.0)

        yield Progress(stage="training", progress=0.0)
        self._train_pairwise(chosen, rejected)
        await asyncio.sleep(0)
        yield Progress(stage="training", progress=1.0)

        # 留出 20% 验证集评估（确定性切分，便于测试复现）
        yield Progress(stage="evaluating", progress=0.0)
        n = len(samples)
        n_val = max(int(n * VAL_RATIO), 1)
        idx = np.arange(n)
        val_idx = idx[idx % int(1 / VAL_RATIO) == 0][:n_val]  # 等距抽样
        val_c, val_r = chosen[val_idx], rejected[val_idx]
        s_c = self._raw_score(val_c)
        s_r = self._raw_score(val_r)
        accuracy = float((s_c > s_r).mean())
        tau = _kendall_tau(
            np.concatenate([s_c, s_r]),
            np.concatenate([np.ones(n_val), np.zeros(n_val)]),
        )
        await asyncio.sleep(0)
        yield Progress(stage="evaluating", progress=1.0)

        # 持久化模型与训练指标（与 Done 帧一致保留 4 位小数）
        version = self._save(
            accuracy=round(accuracy, 4),
            kendall_tau=round(tau, 4),
            sample_count=n,
        )
        yield Done.model_validate(
            {
                "sampleCount": n,
                "version": version,
                "metrics": {
                    "accuracy": round(accuracy, 4),
                    "kendallTau": round(tau, 4),
                    "valPairs": int(n_val),
                    "featureDim": FEATURE_DIM,
                },
            }
        )
