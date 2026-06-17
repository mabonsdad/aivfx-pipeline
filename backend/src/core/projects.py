from __future__ import annotations

from typing import Any


def normalize_project_members(user_ids: list[str] | None) -> list[str]:
    if not isinstance(user_ids, list):
        return []
    output: list[str] = []
    for value in user_ids:
        normalized = str(value or "").strip()
        if normalized and normalized not in output:
            output.append(normalized)
    return output


def normalize_project_record(project: dict[str, Any] | None) -> dict[str, Any]:
    source = project if isinstance(project, dict) else {}
    return {
        "projectId": str(source.get("projectId") or "").strip(),
        "name": str(source.get("name") or "").strip(),
        "description": str(source.get("description") or "").strip() or None,
        "memberUserIds": normalize_project_members(source.get("memberUserIds")),
        "createdAt": source.get("createdAt"),
        "updatedAt": source.get("updatedAt"),
        "createdBy": source.get("createdBy"),
        "updatedBy": source.get("updatedBy"),
    }


def is_project_member(project: dict[str, Any] | None, user_id: str) -> bool:
    if not isinstance(project, dict):
        return False
    normalized_user_id = str(user_id or "").strip()
    if not normalized_user_id:
        return False
    return normalized_user_id in normalize_project_members(project.get("memberUserIds"))


def can_access_project(project: dict[str, Any] | None, *, user_id: str, is_admin: bool) -> bool:
    if is_admin:
        return True
    return is_project_member(project, user_id)


def project_summary(project: dict[str, Any] | None) -> dict[str, Any]:
    normalized = normalize_project_record(project)
    return {
        "projectId": normalized["projectId"],
        "name": normalized["name"],
        "description": normalized["description"],
        "memberUserIds": normalized["memberUserIds"],
        "memberCount": len(normalized["memberUserIds"]),
        "createdAt": normalized["createdAt"],
        "updatedAt": normalized["updatedAt"],
        "createdBy": normalized["createdBy"],
        "updatedBy": normalized["updatedBy"],
    }
