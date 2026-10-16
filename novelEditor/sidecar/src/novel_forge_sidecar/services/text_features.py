"""文本手工特征提取（SPEC §8.6 / §10 成长系统共用）。

不引入 torch / sentence-transformers 等重依赖，纯 numpy + 正则实现：
- 10 维可解释手工特征（长度 / 段落 / 对话占比 / 标点密度 / 钩子词等），
  名称见 HAND_FEATURE_NAMES，供奖励模型与演化模板共用；
- 16 维哈希 trick 字符 bigram 词袋低维投影，捕捉词法层面的残留信号。

总维度 FEATURE_DIM = len(HAND_FEATURE_NAMES) + HASH_DIM（固定）。
"""

from __future__ import annotations

import math
import re

import numpy as np

# 钩子词：制造悬念 / 转折的高频信号词
_HOOK_WORDS = ("突然", "忽然", "却", "竟然", "没想到", "谁知", "刹那", "霎时", "骤然")

# 句读符号
_SENTENCE_SPLIT = re.compile(r"[。！？!?；;…]+")
_PUNCT = re.compile(r"[，。！？；：、…—·「」『』“”‘’（）《》〈〉,.!?;:'\"()\[\]<>-]")
_DIALOGUE_QUOTE = re.compile(r"[「『“](.*?)[」』”]", re.S)

HAND_FEATURE_NAMES: list[str] = [
    "charLength",          # 字符数（log1p 缩放）
    "paragraphCount",      # 段落数
    "avgParagraphLength",  # 平均段落长度
    "sentenceCount",       # 句子数
    "avgSentenceLength",   # 平均句长
    "shortSentenceRatio",  # 短句（<=15 字）占比
    "dialogueRatio",       # 引号内字符占比（对话占比代理）
    "punctDensity",        # 标点密度（标点数 / 字符数）
    "questionExclaimRatio",  # 问号叹号占句读比例（情绪张力代理）
    "hookWordCount",       # 钩子词出现次数
    "uniqueCharRatio",     # 去重字符比（词汇丰富度代理）
]

HASH_DIM = 16
FEATURE_DIM = len(HAND_FEATURE_NAMES) + HASH_DIM


def hand_features(text: str) -> dict[str, float]:
    """提取可解释手工特征，返回 {特征名: 值}（未标准化）。"""
    text = text or ""
    chars = len(text)
    paragraphs = [p for p in re.split(r"\n+", text) if p.strip()]
    sentences = [s for s in _SENTENCE_SPLIT.split(text) if s.strip()]

    dialogue_chars = sum(len(m) for m in _DIALOGUE_QUOTE.findall(text))
    puncts = len(_PUNCT.findall(text))
    qe_marks = len(re.findall(r"[！？!?]", text))
    sent_end_marks = len(re.findall(r"[。！？!?；;…]", text))
    short_sents = sum(1 for s in sentences if len(s) <= 15)
    hooks = sum(text.count(w) for w in _HOOK_WORDS)

    return {
        "charLength": math.log1p(chars),
        "paragraphCount": float(len(paragraphs)),
        "avgParagraphLength": chars / max(len(paragraphs), 1),
        "sentenceCount": float(len(sentences)),
        "avgSentenceLength": chars / max(len(sentences), 1),
        "shortSentenceRatio": short_sents / max(len(sentences), 1),
        "dialogueRatio": dialogue_chars / max(chars, 1),
        "punctDensity": puncts / max(chars, 1),
        "questionExclaimRatio": qe_marks / max(sent_end_marks, 1),
        "hookWordCount": float(hooks),
        "uniqueCharRatio": len(set(text)) / max(chars, 1),
    }


def _hash_bigram_projection(text: str) -> np.ndarray:
    """字符 bigram 哈希到 HASH_DIM 维并 L2 归一化（哈希 trick 词袋投影）。"""
    vec = np.zeros(HASH_DIM, dtype=np.float64)
    if len(text) >= 2:
        for i in range(len(text) - 1):
            vec[hash(text[i : i + 2]) % HASH_DIM] += 1.0
        norm = float(np.linalg.norm(vec))
        if norm > 0:
            vec /= norm
    return vec


def extract_features(text: str) -> np.ndarray:
    """完整特征向量：手工特征 + 哈希投影，长度恒为 FEATURE_DIM。"""
    hand = hand_features(text)
    hand_vec = np.array([hand[name] for name in HAND_FEATURE_NAMES], dtype=np.float64)
    return np.concatenate([hand_vec, _hash_bigram_projection(text)])
