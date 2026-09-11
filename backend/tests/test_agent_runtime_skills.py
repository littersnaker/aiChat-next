"""Agent Runtime 技能选择逻辑测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.runtime.agent_runtime import AgentRuntime
from backend.services.skills.contracts import SkillDefinition


def _skill(skill_id: str, name: str) -> SkillDefinition:
    """构造一个最小可用的 Skill 定义。"""

    return SkillDefinition(
        id=skill_id,
        name=name,
        version="1.0.0",
        description=f"{name} 技能",
        scope="user",
        prompt="示例提示词",
        tools=(),
        memory=(),
        permissions={},
        requires_reasoning=False,
        source_path=Path(f"/tmp/{skill_id}"),
    )


class _StubRegistry:
    """替身 SkillRegistry：只实现 resolve，未知 ID 抛 KeyError。"""

    def __init__(self, skills: dict[str, SkillDefinition]) -> None:
        self._skills = skills

    def resolve(self, skill_ids: tuple[str, ...]) -> list[SkillDefinition]:
        resolved: list[SkillDefinition] = []
        for skill_id in skill_ids:
            if skill_id not in self._skills:
                raise KeyError(f"未注册 Skill：{skill_id}")
            resolved.append(self._skills[skill_id])
        return resolved


def _runtime_with_skills(skills: dict[str, SkillDefinition]) -> AgentRuntime:
    """绕过重型 __init__，只注入被测方法用到的注册表。"""

    runtime = object.__new__(AgentRuntime)
    runtime._skills = _StubRegistry(skills)  # type: ignore[attr-defined]
    return runtime


def _patch_installer(monkeypatch, candidates: list[dict[str, object]]) -> list[str]:
    """替换 installer 的候选与用量记录函数，返回用量记录列表。"""

    async def fake_list(agent_id: str, *, limit: int = 50):
        return candidates

    recorded: list[str] = []

    async def fake_record(skill_id: str) -> None:
        recorded.append(skill_id)

    monkeypatch.setattr(
        "backend.services.skills.installer.list_enabled_skills_for_agent",
        fake_list,
    )
    monkeypatch.setattr(
        "backend.services.skills.installer.record_skill_usage",
        fake_record,
    )
    return recorded


@pytest.mark.asyncio
async def test_select_skills_returns_empty_when_store_unavailable(monkeypatch) -> None:
    """数据库未初始化时应静默返回空列表，而不是让主流程失败。"""

    import sqlite3

    async def broken(agent_id: str, *, limit: int = 50):
        raise sqlite3.OperationalError("no such table")

    monkeypatch.setattr(
        "backend.services.skills.installer.list_enabled_skills_for_agent",
        broken,
    )
    runtime = _runtime_with_skills({})
    assert await runtime._select_enabled_skills(agent_id="qa", task_text="任意") == []


@pytest.mark.asyncio
async def test_select_skills_returns_empty_without_candidates(monkeypatch) -> None:
    """候选池为空时直接返回。"""

    _patch_installer(monkeypatch, [])
    runtime = _runtime_with_skills({})
    assert await runtime._select_enabled_skills(agent_id="qa", task_text="任意") == []


@pytest.mark.asyncio
async def test_select_skills_resolves_and_records_usage(monkeypatch) -> None:
    """命中候选经注册表解析成 SkillDefinition，并记录使用率。"""

    recorded = _patch_installer(
        monkeypatch,
        [
            {"id": "skill_sort", "name": "排序", "tags": ["排序"], "description": ""},
            {"id": "skill_other", "name": "无关", "tags": [], "description": "完全无关"},
        ],
    )
    known = {"skill_sort": _skill("skill_sort", "排序")}
    runtime = _runtime_with_skills(known)

    resolved = await runtime._select_enabled_skills(agent_id="qa", task_text="请帮我排序")

    assert [skill.id for skill in resolved] == ["skill_sort"]
    assert recorded == ["skill_sort"]


@pytest.mark.asyncio
async def test_select_skills_skips_unknown_registry_ids(monkeypatch) -> None:
    """候选命中但注册表查不到时应跳过，而不是抛 KeyError。"""

    _patch_installer(
        monkeypatch,
        [
            {"id": "skill_ghost", "name": "排序", "tags": ["排序"], "description": ""},
            {"id": "skill_real", "name": "表格", "tags": ["表格"], "description": ""},
        ],
    )
    known = {"skill_real": _skill("skill_real", "表格")}
    runtime = _runtime_with_skills(known)

    resolved = await runtime._select_enabled_skills(agent_id="qa", task_text="排序和表格都要")

    assert [skill.id for skill in resolved] == ["skill_real"]
