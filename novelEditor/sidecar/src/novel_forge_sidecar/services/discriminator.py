"""风格判别器（SPEC §8.5，任务 5.6/5.7）。

轻量实现（numpy 手写逻辑回归，仿 reward_model.py，不引 torch / sklearn）：
- 特征：extract_style_features 提取 10 维定长风格数值特征；
- 训练：real 标 1、fake 标 0 的逻辑回归（梯度下降 + 特征标准化）；
- fake 为空时自动从 real 生成扰动负样本（句序乱序 / 去句读合并 / 句首截断）；
- 持久化：{data_dir}/discriminator/{style_id}.npz；
- 未训练的 style_id 打分恒返回 0.5（unknown）。
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

import numpy as np

# 比喻标记词（与 stylometry 保持一致）
_METAPHOR_MARKERS = ("像", "仿佛", "宛如", "如同", "好似", "犹如")

_SENTENCE_SPLIT_RE = re.compile(r"[。！？!?…]+")
_DIALOGUE_RE = re.compile(r"[「\"“].*?[」\"”]")
_PARAGRAPH_SPLIT_RE = re.compile(r"\n+")

# 训练所需的最小样本数（real + fake 总段落数）
MIN_TRAIN_SAMPLES = 10

STYLE_FEATURE_NAMES: list[str] = [
    "avgSentenceLength",    # 平均句长
    "sentenceLengthStd",    # 句长标准差
    "shortSentenceRatio",   # 短句（<15 字）占比
    "dialogueRatio",        # 引号对白字符占比
    "metaphorDensity",      # 比喻密度（次/千字）
    "avgParagraphLength",   # 平均段长
    "commaPer1000",         # 逗号频率（个/千字）
    "periodPer1000",        # 句号频率（个/千字）
    "questionPer1000",      # 问号频率（个/千字）
    "exclaimPer1000",       # 叹号频率（个/千字）
]
STYLE_FEATURE_DIM = len(STYLE_FEATURE_NAMES)

# 逻辑回归超参（与 reward_model 同风格）
_LR = 0.5
_L2 = 1e-3
_EPOCHS = 500


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def extract_style_features(text: str) -> list[float]:
    """对单段文本提取定长风格数值特征（维度 = STYLE_FEATURE_DIM）。"""
    text = text or ""
    total_chars = max(len(text), 1)
    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s.strip()]
    paragraphs = [p for p in _PARAGRAPH_SPLIT_RE.split(text) if p.strip()]

    if sentences:
        lengths = np.array([len(s) for s in sentences], dtype=np.float64)
        avg_len = float(lengths.mean())
        std_len = float(lengths.std())
        short_ratio = float((lengths < 15).mean())
    else:
        avg_len = std_len = short_ratio = 0.0

    dialogue_chars = sum(len(m.group(0)) for m in _DIALOGUE_RE.finditer(text))
    metaphor_hits = sum(text.count(m) for m in _METAPHOR_MARKERS)

    return [
        avg_len,
        std_len,
        short_ratio,
        dialogue_chars / total_chars,
        metaphor_hits / total_chars * 1000,
        float(np.mean([len(p) for p in paragraphs])) if paragraphs else 0.0,
        text.count("，") / total_chars * 1000,
        text.count("。") / total_chars * 1000,
        text.count("？") / total_chars * 1000 + text.count("?") / total_chars * 1000,
        text.count("！") / total_chars * 1000 + text.count("!") / total_chars * 1000,
    ]


def _make_fake_samples(real_chunks: list[str]) -> list[str]:
    """从真迹自动生成扰动负样本（SPEC 未规定 fake 来源，见 SPEC-CHANGELOG-PENDING）。

    三种扰动按序轮换：
    1. 段落内句子乱序（确定性种子，保证结果可复现）；
    2. 去掉句读把句子合并（改变句长分布与标点频率）；
    3. 句首截断。
    """
    fakes: list[str] = []
    for i, chunk in enumerate(real_chunks):
        sents = [s.strip() for s in _SENTENCE_SPLIT_RE.split(chunk) if s.strip()]
        mode = i % 3
        if mode == 0 and len(sents) >= 2:
            rng = np.random.default_rng(seed=i)
            order = list(rng.permutation(len(sents)))
            if order == sorted(order):
                order.reverse()
            fakes.append("。".join(sents[j] for j in order) + "。")
        elif mode == 1 and len(sents) >= 2:
            # 去句读合并：句子变长、标点变稀
            fakes.append("，".join(sents) + "。")
        else:
            cut = min(8, max(1, len(chunk) // 4))
            fakes.append(chunk[cut:])
    return fakes


class StyleDiscriminator:
    """按 style_id 隔离的逻辑回归风格判别器。"""

    def __init__(self, data_dir: Optional[Path | str] = None) -> None:
        root = Path(data_dir) if data_dir else Path(os.environ.get("NV_DATA_DIR", "./data"))
        self._dir = root / "models" / "discriminator"
        # style_id -> (weights, bias, mean, std)
        self._models: dict[str, tuple[np.ndarray, float, np.ndarray, np.ndarray]] = {}

    # ------------------------------------------------------------------
    # 持久化
    # ------------------------------------------------------------------

    def _path(self, style_id: str) -> Path:
        return self._dir / f"{style_id}.npz"

    def is_trained(self, style_id: str) -> bool:
        return style_id in self._models or self._path(style_id).exists()

    def delete(self, style_id: str) -> None:
        """删除某个风格的判别器模型文件与内存缓存。"""
        self._models.pop(style_id, None)
        path = self._path(style_id)
        if path.exists():
            path.unlink()

    def _load(self, style_id: str) -> Optional[tuple[np.ndarray, float, np.ndarray, np.ndarray]]:
        if style_id in self._models:
            return self._models[style_id]
        path = self._path(style_id)
        if not path.exists():
            return None
        try:
            data = np.load(path)
            model = (data["weights"], float(data["bias"]), data["mean"], data["std"])
        except (OSError, KeyError, ValueError):
            return None
        self._models[style_id] = model
        return model

    def _save(
        self,
        style_id: str,
        weights: np.ndarray,
        bias: float,
        mean: np.ndarray,
        std: np.ndarray,
    ) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        np.savez(
            self._path(style_id),
            weights=weights,
            bias=np.float64(bias),
            mean=mean,
            std=std,
        )
        self._models[style_id] = (weights, bias, mean, std)

    # ------------------------------------------------------------------
    # 训练 / 打分
    # ------------------------------------------------------------------

    def train(self, style_id: str, real_chunks: list[str], fake_chunks: list[str]) -> None:
        """real 标 1、fake 标 0 训练逻辑回归；样本不足抛 ValueError。"""
        real = [c for c in real_chunks if c and c.strip()]
        fake = [c for c in fake_chunks if c and c.strip()]
        if not fake:
            fake = _make_fake_samples(real)
        if len(real) + len(fake) < MIN_TRAIN_SAMPLES:
            raise ValueError(
                f"判别器训练样本不足：{len(real) + len(fake)} < {MIN_TRAIN_SAMPLES}"
            )

        feats = np.stack([extract_style_features(t) for t in real + fake])
        labels = np.array([1.0] * len(real) + [0.0] * len(fake), dtype=np.float64)

        mean = feats.mean(axis=0)
        std = feats.std(axis=0)
        std[std < 1e-8] = 1.0  # 常数维度防除零
        x = (feats - mean) / std

        n = len(x)
        w = np.zeros(STYLE_FEATURE_DIM, dtype=np.float64)
        b = 0.0
        for _ in range(_EPOCHS):
            p = _sigmoid(x @ w + b)
            grad_w = x.T @ (p - labels) / n + _L2 * w
            grad_b = float((p - labels).mean())
            w -= _LR * grad_w
            b -= _LR * grad_b

        self._save(style_id, w, b, mean, std)

    def score(self, style_id: str, text: str) -> float:
        """返回文本属于该风格真迹的概率；未训练返回 0.5（unknown）。"""
        model = self._load(style_id)
        if model is None:
            return 0.5
        weights, bias, mean, std = model
        feat = np.asarray(extract_style_features(text), dtype=np.float64)
        return float(_sigmoid((feat - mean) / std @ weights + bias))
