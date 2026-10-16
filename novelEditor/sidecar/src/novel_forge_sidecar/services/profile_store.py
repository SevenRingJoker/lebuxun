"""风格档案存储（SPEC §5.3：风格报告存文件系统 data/styles/{styleId}/report.md）。

每个风格一个目录：
- profile.json：StyleProfile 完整序列化（camelCase 别名）；
- report.md：风格报告 markdown 原文（report.sections["full"]，缺省时由
  summary + 各小节拼写）。

数据目录默认取环境变量 NV_DATA_DIR，缺省 ./data。
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from novel_forge_sidecar.models.schemas import StyleProfile


class ProfileStore:
    """按 style_id 组织的文件系统档案库。"""

    def __init__(self, data_dir: str | Path | None = None) -> None:
        self._root = Path(data_dir) if data_dir else Path(os.environ.get("NV_DATA_DIR", "./data"))

    # ------------------------------------------------------------------
    # 路径
    # ------------------------------------------------------------------

    def style_dir(self, style_id: str) -> Path:
        return self._root / "styles" / style_id

    def report_path(self, style_id: str) -> Path:
        return self.style_dir(style_id) / "report.md"

    # ------------------------------------------------------------------
    # 读写
    # ------------------------------------------------------------------

    def save(self, profile: StyleProfile) -> Path:
        """写入 profile.json 与 report.md，返回 report.md 路径。"""
        d = self.style_dir(profile.id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "profile.json").write_text(
            profile.model_dump_json(by_alias=True, indent=2), encoding="utf-8"
        )
        report_md = profile.report.sections.get("full") or self._compose_markdown(profile)
        rp = self.report_path(profile.id)
        rp.write_text(report_md, encoding="utf-8")
        return rp

    def get(self, style_id: str) -> StyleProfile | None:
        """读取档案；不存在或文件损坏返回 None。"""
        path = self.style_dir(style_id) / "profile.json"
        if not path.exists():
            return None
        try:
            return StyleProfile.model_validate_json(path.read_text(encoding="utf-8"))
        except ValueError:
            return None

    def list(self) -> list[StyleProfile]:
        """列出全部档案（按创建时间升序）。"""
        root = self._root / "styles"
        if not root.exists():
            return []
        profiles = [p for p in (self.get(d.name) for d in root.iterdir() if d.is_dir()) if p]
        profiles.sort(key=lambda p: p.created_at)
        return profiles

    def delete(self, style_id: str) -> bool:
        """连目录一起删除；返回是否确实存在过。"""
        d = self.style_dir(style_id)
        if not d.exists():
            return False
        shutil.rmtree(d)
        return True

    # ------------------------------------------------------------------

    @staticmethod
    def _compose_markdown(profile: StyleProfile) -> str:
        """report.sections 无 full 原文时，由 summary + 小节拼出 markdown。"""
        parts = [f"# {profile.author_name} 风格报告", ""]
        if profile.report.summary:
            parts += [profile.report.summary, ""]
        for name, body in profile.report.sections.items():
            if name == "full":
                continue
            parts += [f"## {name}", "", body, ""]
        return "\n".join(parts).strip() + "\n"
