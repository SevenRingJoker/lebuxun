"""文本处理工具：章节切分、清洗、质量检查。

对应 SPEC §8.4 流水线中的 Stage 1（结构化）与 Stage 2（清洗）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# “第X章 / 第X回 / 第X节”等章节标题正则（支持中文数字与阿拉伯数字）
_CHAPTER_RE = re.compile(
    r"^\s*第[0-9零一二三四五六七八九十百千两]+[章回节卷部][^\n]*$",
    re.MULTILINE,
)

# 常见网文广告 / 水印行
_AD_PATTERNS = [
    re.compile(r".*最新章节.*地址.*"),
    re.compile(r".*本书首发.*"),
    re.compile(r".*请记住本书.*域名.*"),
    re.compile(r".*无弹窗.*"),
    re.compile(r".*笔趣阁.*"),
    re.compile(r".*www\.[A-Za-z0-9.\-]+.*"),
    re.compile(r".*天才一秒钟就记住.*"),
]


@dataclass
class Chapter:
    """切分后的章节。"""

    index: int
    title: str
    text: str
    paragraphs: list[str] = field(default_factory=list)


def split_chapters(text: str) -> list[Chapter]:
    """按“第X章”标题把 TXT 全文切成章节列表。

    标题行之前的文字归入 index=0 的“卷首”章节（若为空则丢弃）。
    """
    matches = list(_CHAPTER_RE.finditer(text))
    chapters: list[Chapter] = []

    if not matches:
        # 没有章节标题：整体视为一章
        paragraphs = _split_paragraphs(text)
        if paragraphs:
            chapters.append(Chapter(index=0, title="", text=text.strip(), paragraphs=paragraphs))
        return chapters

    # 卷首内容
    head = text[: matches[0].start()].strip()
    if head:
        chapters.append(Chapter(index=0, title="卷首", text=head, paragraphs=_split_paragraphs(head)))

    for i, m in enumerate(matches):
        title = m.group(0).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        chapters.append(
            Chapter(index=len(chapters), title=title, text=body, paragraphs=_split_paragraphs(body))
        )
    return chapters


def _split_paragraphs(text: str) -> list[str]:
    """按空行 / 换行拆段，去掉空段。"""
    return [p.strip() for p in re.split(r"\n+", text) if p.strip()]


def clean(text: str) -> str:
    """去广告 / 水印：逐行过滤命中规则的行，并压缩多余空行。"""
    kept: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if any(p.match(stripped) for p in _AD_PATTERNS):
            continue
        kept.append(stripped)
    return "\n".join(kept)


def quality_check(text: str, min_length: int = 50) -> bool:
    """质量检查骨架：过短或空白占比异常的章节判为不合格。"""
    if len(text) < min_length:
        return False
    # 非中文字符占比过高（如乱码）视为低质量
    non_cjk = sum(1 for ch in text if not ("一" <= ch <= "鿿") and not ch.isspace())
    return non_cjk / max(len(text), 1) < 0.6
