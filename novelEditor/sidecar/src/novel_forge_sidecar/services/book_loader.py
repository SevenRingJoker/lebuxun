"""书籍加载（SPEC §8.4 Stage 1 前置 / 任务 5.1）。

支持格式：
- .txt：优先 utf-8 解码，失败回退 gbk；
- .epub：stdlib zipfile 解包，按 OPF spine 顺序读取 XHTML，
  用 BeautifulSoup 提取纯文本（无 OPF 时回退按文件名排序）。

不支持的扩展名抛 ValueError。
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from xml.etree import ElementTree

from bs4 import BeautifulSoup

# epub 内视为正文 HTML 的扩展名
_HTML_SUFFIXES = (".xhtml", ".html", ".htm")


def load_book(path: str | Path) -> str:
    """读取书籍文件并返回全文文本。"""
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix == ".txt":
        return _load_txt(p)
    if suffix == ".epub":
        return _load_epub(p)
    raise ValueError(f"不支持的书籍格式: {suffix or p.name}")


def _load_txt(path: Path) -> str:
    """TXT：utf-8 优先，UnicodeDecodeError 时回退 gbk。"""
    data = path.read_bytes()
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("gbk", errors="replace")


def _load_epub(path: Path) -> str:
    """EPUB：按 spine 顺序拼接各 HTML 文档的纯文本。"""
    with zipfile.ZipFile(path) as zf:
        names = _spine_html_order(zf)
        parts: list[str] = []
        for name in names:
            soup = BeautifulSoup(zf.read(name), "html.parser")
            text = soup.get_text("\n")
            if text.strip():
                parts.append(text.strip())
    return "\n\n".join(parts)


def _spine_html_order(zf: zipfile.ZipFile) -> list[str]:
    """解析 container.xml → OPF → spine，返回正文 HTML 的阅读顺序。

    任一步失败回退为按文件名排序的全部 HTML。
    """
    fallback = sorted(
        n for n in zf.namelist() if n.lower().endswith(_HTML_SUFFIXES)
    )
    try:
        container = ElementTree.fromstring(zf.read("META-INF/container.xml"))
        opf_path = next(
            el.get("full-path")
            for el in container.iter()
            if el.tag.rsplit("}", 1)[-1] == "rootfile"
        )
        if not opf_path:
            return fallback
        opf = ElementTree.fromstring(zf.read(opf_path))
        base = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""
        manifest: dict[str, str] = {}
        spine_refs: list[str] = []
        for el in opf.iter():
            tag = el.tag.rsplit("}", 1)[-1]
            if tag == "item" and "html" in (el.get("media-type") or ""):
                manifest[el.get("id") or ""] = el.get("href") or ""
            elif tag == "itemref":
                spine_refs.append(el.get("idref") or "")
        ordered = [base + manifest[ref] for ref in spine_refs if manifest.get(ref)]
        # 只保留压缩包内真实存在的条目
        return [n for n in ordered if n in zf.namelist()] or fallback
    except (KeyError, ElementTree.ParseError, StopIteration):
        return fallback
