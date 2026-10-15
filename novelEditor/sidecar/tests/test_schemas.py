"""Schema 契约测试：SceneType 枚举值与 SPEC §6.4 严格一致。"""

from novel_forge_sidecar.models.schemas import SceneType, StyleProfile

SPEC_SCENE_TYPES = [
    "battle",
    "dialogue",
    "daily",
    "psychology",
    "environment",
    "transition",
    "hook",
    "climax",
]


def test_scene_type_values_match_spec() -> None:
    assert [st.value for st in SceneType] == SPEC_SCENE_TYPES


def test_style_profile_camel_case_serialization() -> None:
    """StyleProfile 序列化键名应为 camelCase（与 TS 类型对齐）。"""
    profile = StyleProfile(authorName="测试作家", genre="玄幻")
    data = profile.model_dump(by_alias=True)
    assert "authorName" in data
    assert "bookCount" in data
    assert "ragStats" in data
    assert "createdAt" in data
    assert "author_name" not in data
