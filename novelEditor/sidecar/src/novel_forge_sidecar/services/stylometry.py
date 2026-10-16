"""统计文体学特征（stylometry）。

compute_stylometry 计算 StyleFingerprint；Phase 1 给出可用的基础统计实现。
"""

from __future__ import annotations

import re
from collections import Counter

import numpy as np

from novel_forge_sidecar.models.schemas import StyleFingerprint
from novel_forge_sidecar.utils.text import Chapter

# 句末标点
_SENTENCE_SPLIT_RE = re.compile(r"[。！？!?…]+")
_DIALOGUE_RE = re.compile(r"[「\"“].*?[」\"”]")

# 比喻标记词（任务 5.4：命中数 / 总字符 * 1000 = 每千字比喻密度）
_METAPHOR_MARKERS = ("像", "仿佛", "宛如", "如同", "好似", "犹如")

# signature_words 提取参数：章节间文档频率阈值与上限
_SIGNATURE_DF_RATIO = 0.5
_SIGNATURE_MAX = 20


def _metaphor_density(chapters: list[Chapter], total_chars: int) -> float:
    """比喻标记词命中数 / 总字符 * 1000（每千字）。"""
    hits = sum(ch.text.count(m) for ch in chapters for m in _METAPHOR_MARKERS)
    return hits / max(total_chars, 1) * 1000


def _signature_words(chapters: list[Chapter]) -> list[str]:
    """签名用词：章节间文档频率 df ≥ 50% 的 2-gram 中，按总频次取 top（最多 20 个）。

    思路与 top_words 一致（字符级 2-gram），但要求跨章节稳定出现，
    过滤只在个别章节爆发的偶发用词。
    """
    if not chapters:
        return []
    df: Counter[str] = Counter()
    tf: Counter[str] = Counter()
    for ch in chapters:
        grams = [ch.text[i : i + 2] for i in range(len(ch.text) - 1)]
        df.update(set(grams))
        tf.update(grams)
    min_df = max(1, int(len(chapters) * _SIGNATURE_DF_RATIO + 0.5))
    candidates = [(g, tf[g]) for g, d in df.items() if d >= min_df]
    candidates.sort(key=lambda x: x[1], reverse=True)
    return [g for g, _ in candidates[:_SIGNATURE_MAX]]


def compute_stylometry(chapters: list[Chapter]) -> StyleFingerprint:
    """对全部章节统计句长、对白占比、标点分布、高频词等基础特征。"""
    sentences: list[str] = []
    paragraph_lengths: list[int] = []
    dialogue_chars = 0
    total_chars = 0
    punct_counter: Counter[str] = Counter()
    word_counter: Counter[str] = Counter()

    for ch in chapters:
        for p in ch.paragraphs:
            paragraph_lengths.append(len(p))
            total_chars += len(p)
            dialogue_chars += sum(len(m.group(0)) for m in _DIALOGUE_RE.finditer(p))
            for ch_ in p:
                if ch_ in "，。！？；：、…—":
                    punct_counter[ch_] += 1
            for s in _SENTENCE_SPLIT_RE.split(p):
                s = s.strip()
                if s:
                    sentences.append(s)
                    # 简易 2-gram 词频（中文按字二元切分，占位用）
                    for i in range(len(s) - 1):
                        word_counter[s[i : i + 2]] += 1

    lengths = np.array([len(s) for s in sentences], dtype=np.float64) if sentences else np.array([0.0])
    punct_total = sum(punct_counter.values()) or 1

    return StyleFingerprint(
        avg_sentence_length=float(lengths.mean()),
        sentence_length_std=float(lengths.std()),
        short_sentence_ratio=float((lengths < 15).mean()),
        avg_paragraph_length=float(np.mean(paragraph_lengths)) if paragraph_lengths else 0.0,
        dialogue_ratio=dialogue_chars / max(total_chars, 1),
        metaphor_density=_metaphor_density(chapters, total_chars),
        punctuation={k: v / punct_total for k, v in punct_counter.most_common(10)},
        top_words=[w for w, _ in word_counter.most_common(20)],
        signature_words=_signature_words(chapters),
        # 禁忌词由用户配置，不自动推断（见 SPEC-CHANGELOG-PENDING）
        forbidden_words=[],
    )
