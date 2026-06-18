from __future__ import annotations

from datetime import datetime
from typing import Any, Callable

import boto3

from src.core.http import parse_json_body
from src.core.projects import normalize_project_members, normalize_project_record, project_summary
from src.core.prompt_wizard_admin import (
    ADMIN_PROMPT_WIZARD_CONFIG_KEY,
    is_prompt_wizard_admin,
    is_valid_prompt_wizard_admin_pin,
    normalize_prompt_wizard_admin_config_for_read,
    normalize_prompt_wizard_admin_config_for_write,
)
from src.models.schemas import AdminProjectUpsertRequest


def _header_value(event: dict[str, Any], name: str) -> str | None:
    headers = event.get("headers")
    if not isinstance(headers, dict):
        return None
    for key, value in headers.items():
        if str(key).lower() != name.lower():
            continue
        if isinstance(value, str):
            return value
    return None


def _claim_pool_id(claims: dict[str, Any]) -> str | None:
    issuer = str(claims.get("iss") or "").strip().rstrip("/")
    if not issuer:
        return None
    return issuer.split("/")[-1] or None


def _user_attribute(attributes: list[dict[str, Any]] | None, name: str) -> str | None:
    if not isinstance(attributes, list):
        return None
    for attribute in attributes:
        if str(attribute.get("Name") or "") != name:
            continue
        value = str(attribute.get("Value") or "").strip()
        return value or None
    return None


def _list_cognito_users(user_pool_id: str) -> list[dict[str, Any]]:
    client = boto3.client("cognito-idp")
    paginator = client.get_paginator("list_users")
    output: list[dict[str, Any]] = []
    for page in paginator.paginate(UserPoolId=user_pool_id):
        for item in page.get("Users") or []:
            username = str(item.get("Username") or "").strip()
            sub = _user_attribute(item.get("Attributes"), "sub")
            email = _user_attribute(item.get("Attributes"), "email")
            enabled = bool(item.get("Enabled", False))
            created_at = item.get("UserCreateDate")
            modified_at = item.get("UserLastModifiedDate")
            groups: list[str] = []
            if username:
                try:
                    groups_page = client.admin_list_groups_for_user(UserPoolId=user_pool_id, Username=username)
                    groups = [
                        str(group.get("GroupName") or "").strip()
                        for group in groups_page.get("Groups") or []
                        if str(group.get("GroupName") or "").strip()
                    ]
                except Exception:
                    groups = []
            output.append(
                {
                    "userId": sub,
                    "username": username or None,
                    "email": email,
                    "enabled": enabled,
                    "status": str(item.get("UserStatus") or "").strip() or None,
                    "groups": groups,
                    "createdAt": created_at.isoformat() if isinstance(created_at, datetime) else None,
                    "updatedAt": modified_at.isoformat() if isinstance(modified_at, datetime) else None,
                }
            )
    output.sort(key=lambda item: str(item.get("email") or item.get("username") or item.get("userId") or "").lower())
    return output


def _summarize_user_metrics(tasks: list[dict[str, Any]], user_projects: dict[str, list[str]]) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}

    def ensure_user(user_id: str) -> dict[str, Any]:
        user_metrics = output.get(user_id)
        if user_metrics is None:
            user_metrics = {
                "taskCount": 0,
                "projectIds": list(user_projects.get(user_id) or []),
                "imageGenerationsTotal": 0,
                "videoGenerationsTotal": 0,
                "imageGenerationsByTool": {},
                "videoGenerationsByTool": {},
            }
            output[user_id] = user_metrics
        return user_metrics

    for task in tasks:
        user_id = str(task.get("userId") or "").strip()
        if not user_id:
            continue
        metrics = ensure_user(user_id)
        metrics["taskCount"] += 1
        project_id = str(task.get("projectId") or "").strip()
        if project_id and project_id not in metrics["projectIds"]:
            metrics["projectIds"].append(project_id)

        for generation in (task.get("segmentGenerations") or {}).values():
            if not isinstance(generation, dict) or generation.get("isChunkInternal"):
                continue
            origin = generation.get("origin") if isinstance(generation.get("origin"), dict) else {}
            tool = str(origin.get("toolOrigin") or "segment_generate").strip() or "segment_generate"
            metrics["videoGenerationsTotal"] += 1
            metrics["videoGenerationsByTool"][tool] = int(metrics["videoGenerationsByTool"].get(tool) or 0) + 1

        for frame in (task.get("frames") or {}).values():
            if not isinstance(frame, dict):
                continue
            for variant in frame.get("variants") or []:
                if not isinstance(variant, dict):
                    continue
                tool = str(variant.get("model") or "frame_variant").strip() or "frame_variant"
                metrics["imageGenerationsTotal"] += 1
                metrics["imageGenerationsByTool"][tool] = int(metrics["imageGenerationsByTool"].get(tool) or 0) + 1

        for reference in task.get("editVideoReferences") or []:
            if not isinstance(reference, dict):
                continue
            if str(reference.get("type") or "").strip() != "generated":
                continue
            tool = str(reference.get("model") or "reference_generate").strip() or "reference_generate"
            metrics["imageGenerationsTotal"] += 1
            metrics["imageGenerationsByTool"][tool] = int(metrics["imageGenerationsByTool"].get(tool) or 0) + 1

    return output


def handle_admin_routes(
    method: str,
    path: str,
    *,
    event: dict[str, Any],
    claims: dict[str, Any],
    store,
    origin: str | None,
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    now_iso_fn: Callable[[], str],
    json_model: Callable[[Any, dict[str, Any]], Any],
    new_id_fn: Callable[[str], str],
) -> dict[str, Any] | None:
    admin_access = is_prompt_wizard_admin(claims)
    pin = _header_value(event, "x-admin-pin")
    pin_access = is_valid_prompt_wizard_admin_pin(pin)
    full_admin_access = admin_access

    if path == "/admin/prompt-wizard-config":
        has_access = admin_access or pin_access
        if not has_access:
            return error_response_fn(403, "Admin access required", origin=origin)

        raw = store.get_json(ADMIN_PROMPT_WIZARD_CONFIG_KEY)
        config = normalize_prompt_wizard_admin_config_for_read(raw)

        if method == "GET":
            return response_fn(
                200,
                {
                    "config": config,
                    "access": {
                        "isAdmin": admin_access,
                        "viaPin": pin_access and not admin_access,
                    },
                },
                origin=origin,
            )

        if method == "PUT":
            try:
                normalized = normalize_prompt_wizard_admin_config_for_write(parse_json_body(event))
            except ValueError as exc:
                return error_response_fn(400, str(exc), origin=origin)

            normalized["updatedAt"] = now_iso_fn()
            normalized["updatedBy"] = str(claims.get("email") or claims.get("cognito:username") or claims.get("sub") or "unknown")
            store.put_json(ADMIN_PROMPT_WIZARD_CONFIG_KEY, normalized)
            return response_fn(
                200,
                {
                    "config": normalized,
                    "access": {
                        "isAdmin": admin_access,
                        "viaPin": pin_access and not admin_access,
                    },
                },
                origin=origin,
            )

        return error_response_fn(405, "Method not allowed", origin=origin)

    if not full_admin_access and path.startswith("/admin/"):
        return error_response_fn(403, "Admin access required", origin=origin)

    if not full_admin_access:
        return None

    if method == "GET" and path == "/admin/projects":
        return response_fn(200, {"projects": [project_summary(project) for project in store.list_projects()]}, origin=origin)

    if method == "POST" and path == "/admin/projects":
        req = json_model(AdminProjectUpsertRequest, event)
        project = normalize_project_record(
            {
                "projectId": new_id_fn("proj"),
                "name": req.name,
                "description": req.description,
                "memberUserIds": normalize_project_members(req.memberUserIds),
                "createdAt": now_iso_fn(),
                "updatedAt": now_iso_fn(),
                "createdBy": str(claims.get("email") or claims.get("cognito:username") or claims.get("sub") or "unknown"),
                "updatedBy": str(claims.get("email") or claims.get("cognito:username") or claims.get("sub") or "unknown"),
            }
        )
        if not project["memberUserIds"]:
            return error_response_fn(400, "At least one member user is required", origin=origin)
        store.save_project(project)
        return response_fn(201, {"project": project_summary(project)}, origin=origin)

    if method == "PUT" and path.startswith("/admin/projects/"):
        project_id = path.split("/")[-1]
        existing = store.load_project(project_id)
        if not isinstance(existing, dict):
            return error_response_fn(404, "Project not found", origin=origin)
        req = json_model(AdminProjectUpsertRequest, event)
        project = normalize_project_record(
            {
                **existing,
                "name": req.name,
                "description": req.description,
                "memberUserIds": normalize_project_members(req.memberUserIds),
                "updatedBy": str(claims.get("email") or claims.get("cognito:username") or claims.get("sub") or "unknown"),
            }
        )
        if not project["memberUserIds"]:
            return error_response_fn(400, "At least one member user is required", origin=origin)
        store.save_project(project)
        return response_fn(200, {"project": project_summary(project)}, origin=origin)

    if method == "GET" and path == "/admin/users":
        user_pool_id = _claim_pool_id(claims)
        if not user_pool_id:
            return error_response_fn(500, "User pool could not be resolved from claims", origin=origin)
        try:
            cognito_users = _list_cognito_users(user_pool_id)
        except Exception as exc:
            return error_response_fn(500, f"Could not list Cognito users: {exc}", origin=origin)
        projects = store.list_projects()
        user_projects: dict[str, list[str]] = {}
        for project in projects:
            project_id = str(project.get("projectId") or "").strip()
            if not project_id:
                continue
            for member_user_id in normalize_project_members(project.get("memberUserIds")):
                user_projects.setdefault(member_user_id, []).append(project_id)
        metrics_by_user = _summarize_user_metrics(store.list_all_tasks(), user_projects)
        users = []
        for user in cognito_users:
            user_id = str(user.get("userId") or "").strip()
            metrics = metrics_by_user.get(user_id)
            users.append(
                {
                    **user,
                    "taskCount": int(metrics.get("taskCount") or 0) if isinstance(metrics, dict) else 0,
                    "projectIds": list(metrics.get("projectIds") or []) if isinstance(metrics, dict) else [],
                    "imageGenerationsTotal": int(metrics.get("imageGenerationsTotal") or 0) if isinstance(metrics, dict) else 0,
                    "videoGenerationsTotal": int(metrics.get("videoGenerationsTotal") or 0) if isinstance(metrics, dict) else 0,
                    "imageGenerationsByTool": dict(metrics.get("imageGenerationsByTool") or {}) if isinstance(metrics, dict) else {},
                    "videoGenerationsByTool": dict(metrics.get("videoGenerationsByTool") or {}) if isinstance(metrics, dict) else {},
                }
            )
        return response_fn(
            200,
            {
                "users": users,
                "projects": [project_summary(project) for project in projects],
            },
            origin=origin,
        )

    return None
