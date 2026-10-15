"""场景分类器（Phase 1 规则法实现）。

按关键词与引号占比对段落粗分 8 类场景，输出得分最高的一类及置信度。
后续 Phase 可替换为模型法，接口保持不变。
"""

from __future__ import annotations

import re

from novel_forge_sidecar.models.schemas import SceneType

# 各类场景的关键词表（权重相等，命中即 +1）
_KEYWORDS: dict[SceneType, list[str]] = {
    SceneType.BATTLE: ["战", "杀", "剑", "刀", "拳", "轰", "攻击", "鲜血", "交手", "斩杀", "灵气爆发"],
    SceneType.DIALOGUE: ["说道", "问道", "答道", "笑道", "冷声道", "低声道", "开口"],
    SceneType.DAILY: ["早饭", "茶", "酒馆", "集市", "铺子", "睡", "洗漱", "闲逛", "日常"],
    SceneType.PSYCHOLOGY: ["心中", "暗道", "念头", "思绪", "心想", "隐隐觉得", "回忆", "犹豫"],
    SceneType.ENVIRONMENT: ["天空", "云", "山", "风", "雨", "雪", "江", "月", "暮色", "夜色", "远处"],
    SceneType.TRANSITION: ["与此同时", "另一边", "数日之后", "转眼", "次日", "翌日", "三日后", "此时"],
    SceneType.HOOK: ["忽然", "就在此时", "竟然", "谁知", "变故", "异变", "突然", "没想到"],
    SceneType.CLIMAX: ["终于", "决战", "真相", "最后一刻", "爆发", "全力", "胜负", "生死"],
}

# 引号对白检测
_DIALOGUE_RE = re.compile(r"[「\"“].{1,80}?[」\"”]")


def classify(text: str) -> tuple[SceneType, float]:
    """返回 (场景类型, 置信度)。

    计分 = 关键词命中数；对白占比高时额外加权 dialogue。
    置信度 = 最高分 / 全部得分之和（全零时默认 daily、置信度 0）。
    """
    scores: dict[SceneType, float] = {st: 0.0 for st in SceneType}
    for st, words in _KEYWORDS.items():
        scores[st] = float(sum(1 for w in words if w in text))

    # 对白占比：引号内字数 / 总字数，高则偏向 dialogue
    dialogue_chars = sum(len(m.group(0)) for m in _DIALOGUE_RE.finditer(text))
    if len(text) > 0 and dialogue_chars / len(text) > 0.3:
        scores[SceneType.DIALOGUE] += 3.0

    total = sum(scores.values())
    if total <= 0:
        return SceneType.DAILY, 0.0
    best = max(scores, key=lambda st: scores[st])
    return best, round(scores[best] / total, 4)


class SceneTagger:
    """面向对象的封装，供流水线注入。"""

    def classify(self, text: str) -> tuple[SceneType, float]:
        return classify(text)
