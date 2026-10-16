"""LLM 深度风格分析（SPEC §8.4 Stage 5 / §11.4.2，任务 5.5）。

- 配置模型（环境变量 NV_STYLE_LLM_MODEL，默认空串 = 跳过 LLM）时，
  用 ollama.AsyncClient.chat 让模型读均匀抽样的章节输出风格指南 markdown；
- 未配置模型或调用失败时降级：由统计指纹生成模板 markdown。
两种路径产出同一结构 StyleReport{summary, sections}，sections["full"] 存原文。
"""

from __future__ import annotations

import os
from typing import Any, Optional

from novel_forge_sidecar.models.schemas import StyleFingerprint, StyleReport
from novel_forge_sidecar.services.stylometry import compute_stylometry
from novel_forge_sidecar.utils.text import Chapter

# 模型名环境变量（SPEC §16：模型名可配置，不硬编码）
ENV_STYLE_LLM_MODEL = "NV_STYLE_LLM_MODEL"
ENV_OLLAMA_HOST = "NV_OLLAMA_HOST"
_DEFAULT_OLLAMA_HOST = "http://localhost:11434"

# 抽样章节正文截断长度（字）
_SAMPLE_TRUNCATE = 1500
# 模板报告的六个固定小节（对应 SPEC §11.4.2）
REPORT_SECTIONS = ("叙事视角", "节奏", "对白", "爽点", "用词", "禁忌")


def select_sample_size(n_chapters: int) -> int:
    """SPEC §8.4 引用但未定义的抽样规模函数：至多 8 章，至少 1 章。"""
    return max(1, min(n_chapters, 8))


def _sample_chapters(chapters: list[Chapter], sample_size: int) -> list[Chapter]:
    """按 sample_size 在章节列表上均匀等距抽样。"""
    n = len(chapters)
    if n <= sample_size:
        return list(chapters)
    step = n / sample_size
    return [chapters[int(i * step)] for i in range(sample_size)]


def _parse_markdown(md: str) -> StyleReport:
    """把 markdown 拆成 StyleReport：首非空行为 summary，二级标题切成 sections。"""
    lines = md.splitlines()
    summary = ""
    for line in lines:
        stripped = line.strip().lstrip("#").strip()
        if stripped:
            summary = stripped
            break
    sections: dict[str, str] = {}
    current: Optional[str] = None
    buf: list[str] = []
    for line in lines:
        if line.startswith("## "):
            if current is not None:
                sections[current] = "\n".join(buf).strip()
            current = line[3:].strip()
            buf = []
        elif current is not None:
            buf.append(line)
    if current is not None:
        sections[current] = "\n".join(buf).strip()
    sections["full"] = md
    return StyleReport(summary=summary, sections=sections)


def _template_markdown(fp: StyleFingerprint, n_chapters: int) -> str:
    """无 LLM 时的降级模板：六个小节全部由统计指纹数据填充。"""
    punct = "、".join(f"{k}({v:.1%})" for k, v in list(fp.punctuation.items())[:6]) or "无数据"
    top_words = "、".join(fp.top_words[:10]) or "无数据"
    signature = "、".join(fp.signature_words) or "无数据"
    forbidden = "、".join(fp.forbidden_words) or "未配置（由用户在档案中维护）"
    return f"""# 风格分析报告（统计模板）

> 未配置 LLM（{ENV_STYLE_LLM_MODEL} 为空）或 LLM 不可用，本报告由统计指纹自动生成。

## 叙事视角

统计数据无法判定叙事视角，请配置 LLM 模型后重新分析，或人工通读原文确认。

## 节奏

- 语料章节数：{n_chapters}
- 平均句长：{fp.avg_sentence_length:.1f} 字（标准差 {fp.sentence_length_std:.1f}）
- 短句（<15 字）占比：{fp.short_sentence_ratio:.1%}
- 平均段长：{fp.avg_paragraph_length:.1f} 字

## 对白

- 对白字符占比：{fp.dialogue_ratio:.1%}

## 爽点

- 比喻密度：{fp.metaphor_density:.2f} 次/千字
- 爽点分布需 LLM 阅读章节后总结，当前无数据。

## 用词

- 高频 2-gram：{top_words}
- 签名用词（跨章节稳定出现）：{signature}
- 常用标点：{punct}

## 禁忌

- 禁忌词：{forbidden}
"""


def _fallback_report(chapters: list[Chapter]) -> StyleReport:
    """由统计指纹生成模板报告。"""
    fp = compute_stylometry(chapters)
    return _parse_markdown(_template_markdown(fp, len(chapters)))


def _build_prompt(chapters: list[Chapter], sample_size: int) -> str:
    """拼装 LLM 提示词：均匀抽样章节，每章截前 1500 字。"""
    sampled = _sample_chapters(chapters, sample_size)
    excerpts = []
    for ch in sampled:
        title = ch.title or f"第{ch.index + 1}章"
        excerpts.append(f"【{title}】\n{ch.text[:_SAMPLE_TRUNCATE]}")
    joined = "\n\n".join(excerpts)
    section_titles = "、".join(REPORT_SECTIONS)
    return (
        "你是一位文学风格分析师。以下是同一作家作品的抽样章节，"
        "请通读后输出一份中文风格指南，格式为 markdown，"
        f"必须包含以下六个二级标题小节：{section_titles}。\n\n"
        f"{joined}"
    )


async def llm_analyze(
    chapters: list[Chapter],
    sample_size: int,
    *,
    ollama_client: Any = None,
    model: str = "",
) -> StyleReport:
    """LLM 深度分析；model 为空或调用失败时降级为统计指纹模板。

    model 为空串时读环境变量 NV_STYLE_LLM_MODEL；仍为空则直接走模板。
    """
    model = model or os.environ.get(ENV_STYLE_LLM_MODEL, "")
    if not model or not chapters:
        return _fallback_report(chapters)

    client = ollama_client
    if client is None:
        from ollama import AsyncClient

        client = AsyncClient(host=os.environ.get(ENV_OLLAMA_HOST, _DEFAULT_OLLAMA_HOST))
    try:
        resp = await client.chat(
            model=model,
            messages=[{"role": "user", "content": _build_prompt(chapters, sample_size)}],
        )
        md = str(resp.message.content or "").strip()
        if not md:
            return _fallback_report(chapters)
        return _parse_markdown(md)
    except Exception:
        # LLM 调用失败不阻断流水线，降级为统计模板
        return _fallback_report(chapters)
