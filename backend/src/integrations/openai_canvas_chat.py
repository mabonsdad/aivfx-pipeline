"""Conversational canvas assistant for the lookdev workflow.

A general chat surface (GPT 5.5, OpenAI Responses API) that sits beside the canvas.
The user can talk to it freely: paste a meeting transcript and it summarises it into
the project's memory, ask it to draft prompts, or have it propose reference / prompt
nodes to drop onto the graph.

It reuses the same OpenAI Responses engine plumbing as the prompt wizard (same key,
same cost accounting helpers). The difference is the input is a multi-turn
conversation, the system prompt is the project-aware chat brain, and the output is a
structured result the route can act on:

  - reply           : the assistant's conversational answer (shown in the chat window)
  - memory_updates  : changes the SERVER applies to the project memory store, so the
                      brain's understanding of the project grows over time
  - canvas_actions  : nodes / prompts the FRONTEND should place on the graph

Kept in its own file so the chat concern never edits the prompt-wizard files.
"""

from __future__ import annotations

import json
from typing import Any

import requests

from src.integrations.openai_prompt_wizard import (
    OpenAIPromptWizardError,
    _extract_response_text,
    _usage_from_payload,
)

_OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
_CHAT_MODEL = "gpt-5.5"


CANVAS_CHAT_SYSTEM_PROMPT = """You are the assistant inside an AI image / lookdev canvas application.

You help the user develop the look of a film, one project at a time. You can hold a normal conversation, but your real value is turning what the user tells you into structured work: growing the project's memory, drafting image prompts, and proposing nodes for the canvas graph.

You are given the project's current memory (a rolling summary, known facts, reference images, and learnings) as ground truth about THIS film. Treat it as authoritative. Build on it; never contradict it without the user saying so.

What you can do every turn, via the JSON result you return:

1. reply: a short, direct conversational answer. No filler, no preamble. If you summarised a transcript, say what you captured in a sentence or two, not a wall of text.

2. memory_updates: how the project's understanding should grow. Use this whenever the user gives you durable project facts (world, characters, props, locations, the look of a shot), pastes a transcript or brief, or states a preference/lesson.
   - summary: a rewritten rolling summary of the project so far (or null to leave it unchanged). Keep it tight: a paragraph, not an essay. Fold new information into the existing summary rather than discarding it.
   - facts_add: short, atomic, durable facts to append (one idea each). Do not repeat facts already in memory.
   - references_add: reference images that were discussed. For each, give a clear label and a note describing what the image is and what it is FOR (identity, palette, lighting, set, prop). Put a url only if the user gave you a real one; otherwise null and the user will attach the image to the placeholder node.
   - learnings_add: a durable rule worth remembering, with scope = "general" (true for any project), "project" (true for this film), or "user" (this user's preference). Use sparingly, only for genuine lessons.

3. canvas_actions: things to place on the canvas now. Use this when the user wants nodes built out.
   - add_reference_node: a placeholder/reference image node. Give label + note (what it is, what it's for); url if known else null.
   - add_prompt_node: a new prompt generator node, optionally seeded with a drafted prompt and a shotId.
   - set_prompt: write a drafted prompt onto an existing shot (give shotId + prompt).
   When you draft a prompt, follow good image-prompt practice: concrete and visual, name reference images in order as "image 1", "image 2" (never @img tokens), one role per reference, and cap references at 2 to 4 to avoid drift.

Rules:
- Return ONLY valid JSON matching the schema. No markdown.
- Every field must be present. Use empty arrays and null where you have nothing to add. Do not invent project facts the user did not give you.
- When the user pastes a transcript or long brief, your job is to COMPRESS it into memory_updates (summary + facts + references discussed), not to echo it back.
- Keep canvas_actions to what the user actually asked for. Do not flood the graph with speculative nodes."""


CANVAS_CHAT_JSON_SCHEMA: dict[str, Any] = {
    "type": "json_schema",
    "name": "canvas_chat_result",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "reply": {"type": "string"},
            "memory_updates": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "summary": {"type": ["string", "null"]},
                    "facts_add": {"type": "array", "items": {"type": "string"}},
                    "references_add": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "label": {"type": "string"},
                                "url": {"type": ["string", "null"]},
                                "note": {"type": "string"},
                            },
                            "required": ["label", "url", "note"],
                        },
                    },
                    "learnings_add": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "rule": {"type": "string"},
                                "scope": {"type": "string"},
                            },
                            "required": ["rule", "scope"],
                        },
                    },
                },
                "required": ["summary", "facts_add", "references_add", "learnings_add"],
            },
            "canvas_actions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["add_reference_node", "add_prompt_node", "set_prompt"],
                        },
                        "label": {"type": ["string", "null"]},
                        "shotId": {"type": ["string", "null"]},
                        "prompt": {"type": ["string", "null"]},
                        "url": {"type": ["string", "null"]},
                        "note": {"type": ["string", "null"]},
                    },
                    "required": ["type", "label", "shotId", "prompt", "url", "note"],
                },
            },
        },
        "required": ["reply", "memory_updates", "canvas_actions"],
    },
}


def render_project_context(memory: dict[str, Any] | None) -> str:
    """Render a project memory document into the project_context text for the brain.

    Used by both the chat (as authoritative context) and the prompt wizard (Layer 4
    project facts), so the brain sees the same project knowledge everywhere. Returns
    an empty string when there is nothing useful to send.
    """
    if not isinstance(memory, dict):
        return ""
    parts: list[str] = []
    summary = str(memory.get("summary") or "").strip()
    if summary:
        parts.append(f"PROJECT SUMMARY:\n{summary}")
    facts = [str(f).strip() for f in (memory.get("facts") or []) if str(f).strip()]
    if facts:
        parts.append("PROJECT FACTS:\n" + "\n".join(f"- {f}" for f in facts))
    references = memory.get("references") or []
    ref_lines: list[str] = []
    for ref in references:
        if not isinstance(ref, dict):
            continue
        label = str(ref.get("label") or "").strip()
        note = str(ref.get("note") or "").strip()
        if not label and not note:
            continue
        ref_lines.append(f"- {label}: {note}".strip().rstrip(":"))
    if ref_lines:
        parts.append("REFERENCE IMAGES:\n" + "\n".join(ref_lines))
    learnings = memory.get("learnings") or []
    learn_lines: list[str] = []
    for item in learnings:
        if not isinstance(item, dict):
            continue
        rule = str(item.get("rule") or "").strip()
        if not rule:
            continue
        scope = str(item.get("scope") or "").strip()
        learn_lines.append(f"- ({scope}) {rule}" if scope else f"- {rule}")
    if learn_lines:
        parts.append("LEARNINGS:\n" + "\n".join(learn_lines))
    return "\n\n".join(parts).strip()


def _build_input_messages(
    messages: list[dict[str, Any]],
    *,
    project_context: str | None,
    attachment_image_urls: list[str] | None,
) -> list[dict[str, Any]]:
    """Build the Responses API `input` list from a chat history.

    User turns use input_text; assistant turns use output_text. Project context is
    prepended as a system-style first user turn so the model treats it as ground
    truth. Attachment images are appended to the most recent user turn.
    """
    input_items: list[dict[str, Any]] = []
    if project_context and project_context.strip():
        input_items.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "CURRENT PROJECT MEMORY (ground truth):\n" + project_context.strip(),
                    }
                ],
            }
        )

    # Index of the last user message so we can attach images to it.
    last_user_idx = -1
    for i, m in enumerate(messages):
        if str(m.get("role")) == "user":
            last_user_idx = i

    for i, m in enumerate(messages):
        role = str(m.get("role") or "user")
        text = str(m.get("content") or "")
        if role == "assistant":
            content: list[dict[str, Any]] = [{"type": "output_text", "text": text}]
            input_items.append({"role": "assistant", "content": content})
            continue
        content = [{"type": "input_text", "text": text}]
        if i == last_user_idx:
            for url in attachment_image_urls or []:
                if url:
                    content.append({"type": "input_image", "image_url": url})
        input_items.append({"role": "user", "content": content})
    return input_items


def run_canvas_chat(
    *,
    api_key: str,
    messages: list[dict[str, Any]],
    project_context: str | None = None,
    attachment_image_urls: list[str] | None = None,
    system_prompt: str | None = None,
    pricing_rates: dict[str, float] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run one turn of the canvas chat assistant.

    Returns (result, usage). `result` matches CANVAS_CHAT_JSON_SCHEMA: a conversational
    `reply`, `memory_updates` for the server to apply, and `canvas_actions` for the
    frontend. Temperature is intentionally not sent (gpt-5.5 rejects it).
    """
    if not isinstance(messages, list) or not messages:
        raise OpenAIPromptWizardError("Chat requires at least one message")

    request_body: dict[str, Any] = {
        "model": _CHAT_MODEL,
        "instructions": system_prompt or CANVAS_CHAT_SYSTEM_PROMPT,
        "input": _build_input_messages(
            messages,
            project_context=project_context,
            attachment_image_urls=attachment_image_urls,
        ),
        "text": {"format": CANVAS_CHAT_JSON_SCHEMA},
    }
    response = requests.post(
        _OPENAI_RESPONSES_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=request_body,
        timeout=120,
    )
    if response.status_code >= 400:
        detail = response.text[:2000]
        raise OpenAIPromptWizardError(f"OpenAI Responses API failed ({response.status_code}): {detail}")
    payload = response.json()
    text = _extract_response_text(payload)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise OpenAIPromptWizardError("Canvas chat returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise OpenAIPromptWizardError("Canvas chat returned an invalid response shape")
    result = _normalise_chat_result(parsed)
    return result, _usage_from_payload(payload, _CHAT_MODEL, pricing_rates)


def _normalise_chat_result(parsed: dict[str, Any]) -> dict[str, Any]:
    """Defensive normalisation so the route can trust the shape."""
    reply = str(parsed.get("reply") or "").strip()
    mem = parsed.get("memory_updates") or {}
    if not isinstance(mem, dict):
        mem = {}
    summary = mem.get("summary")
    summary = str(summary).strip() if isinstance(summary, str) and summary.strip() else None
    facts_add = [str(f).strip() for f in (mem.get("facts_add") or []) if str(f).strip()]
    references_add = []
    for ref in mem.get("references_add") or []:
        if not isinstance(ref, dict):
            continue
        label = str(ref.get("label") or "").strip()
        note = str(ref.get("note") or "").strip()
        url = ref.get("url")
        url = str(url).strip() if isinstance(url, str) and url.strip() else None
        if label or note:
            references_add.append({"label": label, "url": url, "note": note})
    learnings_add = []
    for item in mem.get("learnings_add") or []:
        if not isinstance(item, dict):
            continue
        rule = str(item.get("rule") or "").strip()
        if not rule:
            continue
        scope = str(item.get("scope") or "").strip() or "project"
        learnings_add.append({"rule": rule, "scope": scope})
    actions = []
    for a in parsed.get("canvas_actions") or []:
        if not isinstance(a, dict):
            continue
        a_type = str(a.get("type") or "").strip()
        if a_type not in {"add_reference_node", "add_prompt_node", "set_prompt"}:
            continue

        def _opt(key: str) -> str | None:
            v = a.get(key)
            return str(v).strip() if isinstance(v, str) and v.strip() else None

        actions.append(
            {
                "type": a_type,
                "label": _opt("label"),
                "shotId": _opt("shotId"),
                "prompt": _opt("prompt"),
                "url": _opt("url"),
                "note": _opt("note"),
            }
        )
    return {
        "reply": reply,
        "memory_updates": {
            "summary": summary,
            "facts_add": facts_add,
            "references_add": references_add,
            "learnings_add": learnings_add,
        },
        "canvas_actions": actions,
    }
