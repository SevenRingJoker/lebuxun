"""提示词进化（SPEC §10.5 / 任务 4.11）。

把演化模板（4.10 提取的改进指令）嵌入基础 prompt 骨架，生成版本递增的新模板。
纯字符串拼装，不调用 LLM；版本号按 nodeType 单调递增，parentVersion 记录上一版。

持久化：models/evolution/prompt_templates.json。
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Optional

from novel_forge_sidecar.models.schemas import PromptTemplate
from novel_forge_sidecar.services.evolution import EvolutionLearner


class PromptEvolver:
    """提示词版本管理：基于基础模板 + 演化模板生成新版本。"""

    def __init__(
        self,
        model_dir: Optional[Path] = None,
        evolution_learner: Optional[EvolutionLearner] = None,
    ) -> None:
        default = Path(__file__).resolve().parents[3] / "models" / "evolution"
        self._model_dir = Path(model_dir) if model_dir else default
        self._path = self._model_dir / "prompt_templates.json"
        self._learner = evolution_learner or EvolutionLearner(self._model_dir)

    # ------------------------------------------------------------------
    # 持久化
    # ------------------------------------------------------------------

    def _load_all(self) -> list[PromptTemplate]:
        if not self._path.exists():
            return []
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return [PromptTemplate.model_validate(t) for t in data]
        except (OSError, json.JSONDecodeError, ValueError):
            return []

    def _save_all(self, templates: list[PromptTemplate]) -> None:
        self._model_dir.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(
                [t.model_dump(by_alias=True) for t in templates],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    # ------------------------------------------------------------------
    # 查询 / 生成
    # ------------------------------------------------------------------

    def list_templates(self, node_type: Optional[str] = None) -> list[PromptTemplate]:
        """列出全部版本；可按 nodeType 过滤。按版本号升序。"""
        templates = self._load_all()
        if node_type is not None:
            templates = [t for t in templates if t.node_type == node_type]
        return sorted(templates, key=lambda t: (t.node_type, t.version))

    def create_version(
        self,
        base_template: str,
        node_type: str = "generate",
        project_id: Optional[str] = None,
    ) -> PromptTemplate:
        """基于基础模板 + 当前演化模板生成新版本（版本号递增）。"""
        existing = [t for t in self._load_all() if t.node_type == node_type]
        parent = max(existing, key=lambda t: t.version) if existing else None
        version = (parent.version + 1) if parent else 1

        improvements = self._learner.load_templates()
        lines = [base_template.rstrip()]
        if improvements:
            lines.append("")
            lines.append(f"## 改进指令（自动进化 v{version}）")
            for t in improvements:
                lines.append(f"- {t.instruction}（{t.name}，置信度 {t.confidence:.2f}）")
        content = "\n".join(lines)

        template = PromptTemplate(
            id=uuid.uuid4().hex,
            node_type=node_type,
            project_id=project_id,
            version=version,
            parent_version=parent.version if parent else None,
            content=content,
            based_on=[t.id for t in improvements],
            created_at=int(time.time()),
        )
        self._save_all(self._load_all() + [template])
        return template
