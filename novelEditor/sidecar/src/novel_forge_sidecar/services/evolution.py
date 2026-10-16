"""演化模式学习（SPEC §10.4 / 任务 4.10）。

从成对偏好样本中提取「改进模板」：统计 chosen - rejected 在可解释手工特征上的
差分方向，把高支持度的特征差聚成规则模板（如「提升对话占比」「段落切分更细」）。

持久化：models/evolution/templates.json。
"""

from __future__ import annotations

import json
import math
import time
import uuid
from pathlib import Path
from typing import Optional

from novel_forge_sidecar.models.schemas import EvolutionTemplate, PreferenceSample
from novel_forge_sidecar.services.text_features import HAND_FEATURE_NAMES, hand_features

# 提取模板的最小样本数；不足时返回空列表 + 提示
MIN_EXTRACT_SAMPLES = 10
# 模板入选的最小支持度占比
_MIN_SUPPORT_RATIO = 0.2
# 判定「有方向性差分」的 epsilon（相对该特征全样本标准差）
_DELTA_EPS_RATIO = 0.05

# 特征差分方向 → 模板文案（name / description / instruction）
_FEATURE_RULES: dict[str, dict[str, tuple[str, str, str]]] = {
    "dialogueRatio": {
        "up": ("提升对话占比", "被选中文本的对话占比显著更高", "适当增加人物对话比例，用对话推进情节"),
        "down": ("降低对话占比", "被选中文本的对话占比更低", "减少对话堆砌，增加叙述与描写"),
    },
    "paragraphCount": {
        "up": ("段落切分更细", "被选中文本段落数更多、节奏更快", "把长段拆短，增强段落间的呼吸感"),
        "down": ("段落更整", "被选中文本段落更完整", "合并碎段，保持段落内容完整"),
    },
    "avgSentenceLength": {
        "up": ("使用更长的句子", "被选中文本平均句长更长", "适当拉长句式，增加铺陈感"),
        "down": ("使用更短的句子", "被选中文本平均句长更短", "多用短句，加快叙事节奏"),
    },
    "shortSentenceRatio": {
        "up": ("提高短句比例", "被选中文本短句更多", "在关键处用短句制造张力"),
        "down": ("降低短句比例", "被选中文本短句更少", "减少过碎的短句"),
    },
    "hookWordCount": {
        "up": ("增加钩子句", "被选中文本包含更多悬念/转折信号词", "在段首段尾埋钩子，制造悬念与转折"),
        "down": ("减少钩子堆砌", "被选中文本钩子词更少", "克制使用悬念词，避免刻意"),
    },
    "questionExclaimRatio": {
        "up": ("增强情绪张力", "被选中文本问号叹号比例更高", "适当用反问与感叹强化情绪"),
        "down": ("收敛情绪表达", "被选中文本问号叹号比例更低", "减少感叹与反问，保持克制"),
    },
    "punctDensity": {
        "up": ("标点更密", "被选中文本标点密度更高", "句读更密，节奏更碎"),
        "down": ("标点更疏", "被选中文本标点密度更低", "拉长句读，行文更舒展"),
    },
    "uniqueCharRatio": {
        "up": ("用词更丰富", "被选中文本用字多样性更高", "避免重复用词，丰富词汇"),
        "down": ("用词更集中", "被选中文本用字更集中", "保持用词稳定，减少生僻表达"),
    },
    "avgParagraphLength": {
        "up": ("段落更饱满", "被选中文本平均段落更长", "段落内容写足，避免过短碎段"),
        "down": ("段落更轻", "被选中文本平均段落更短", "段落写短，留白更多"),
    },
    "charLength": {
        "up": ("篇幅更长", "被选中文本整体更长", "把内容写足写透"),
        "down": ("篇幅更短", "被选中文本整体更短", "精简表达，去除冗余"),
    },
    "sentenceCount": {
        "up": ("句子更多", "被选中文本句子数更多", "增加句数，展开描写"),
        "down": ("句子更少", "被选中文本句子数更少", "压缩句数，突出重点"),
    },
}


class EvolutionLearner:
    """从成对偏好样本中学习改进模板。"""

    def __init__(self, model_dir: Optional[Path] = None) -> None:
        default = Path(__file__).resolve().parents[3] / "models" / "evolution"
        self._model_dir = Path(model_dir) if model_dir else default
        self._templates_path = self._model_dir / "templates.json"

    # ------------------------------------------------------------------
    # 持久化
    # ------------------------------------------------------------------

    def load_templates(self) -> list[EvolutionTemplate]:
        if not self._templates_path.exists():
            return []
        try:
            data = json.loads(self._templates_path.read_text(encoding="utf-8"))
            return [EvolutionTemplate.model_validate(t) for t in data]
        except (OSError, json.JSONDecodeError, ValueError):
            return []

    def _save_templates(self, templates: list[EvolutionTemplate]) -> None:
        self._model_dir.mkdir(parents=True, exist_ok=True)
        self._templates_path.write_text(
            json.dumps(
                [t.model_dump(by_alias=True) for t in templates],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    # ------------------------------------------------------------------
    # 模板提取
    # ------------------------------------------------------------------

    def extract_templates(
        self, samples: list[PreferenceSample]
    ) -> tuple[list[EvolutionTemplate], str]:
        """提取改进模板。样本不足时返回 ([], 提示信息)。"""
        if len(samples) < MIN_EXTRACT_SAMPLES:
            return [], f"样本不足：当前 {len(samples)} 条，提取模板至少需要 {MIN_EXTRACT_SAMPLES} 条"

        # 逐样本计算 chosen - rejected 的手工特征差
        deltas: dict[str, list[float]] = {name: [] for name in HAND_FEATURE_NAMES}
        for s in samples:
            fc = hand_features(s.chosen)
            fr = hand_features(s.rejected)
            for name in HAND_FEATURE_NAMES:
                deltas[name].append(fc[name] - fr[name])

        n = len(samples)
        min_support = max(3, math.ceil(n * _MIN_SUPPORT_RATIO))
        templates: list[EvolutionTemplate] = []

        for name in HAND_FEATURE_NAMES:
            values = deltas[name]
            mean_abs = sum(abs(v) for v in values) / n
            if mean_abs < 1e-9:
                continue  # 该特征无差分信号
            eps = mean_abs * _DELTA_EPS_RATIO
            up_support = sum(1 for v in values if v > eps)
            down_support = sum(1 for v in values if v < -eps)
            direction = "up" if up_support >= down_support else "down"
            support = max(up_support, down_support)
            if support < min_support or name not in _FEATURE_RULES:
                continue
            signed = [v for v in values if (v > eps if direction == "up" else v < -eps)]
            mean_delta = sum(signed) / len(signed)
            tname, desc, instruction = _FEATURE_RULES[name][direction]
            templates.append(
                EvolutionTemplate(
                    id=uuid.uuid4().hex,
                    name=tname,
                    description=f"{desc}（{support}/{n} 条样本支持）",
                    instruction=instruction,
                    feature_deltas={name: round(mean_delta, 6)},
                    support=support,
                    confidence=round(support / n, 4),
                    created_at=int(time.time()),
                )
            )

        templates.sort(key=lambda t: (-t.confidence, -t.support))
        self._save_templates(templates)
        return templates, ""
