"""Canvas skills: named, triggered GPT capabilities (the harness, not the model).

This is the equivalent of Claude Code's `.claude/skills/` for the lookdev canvas.
A skill is a named capability with its own brain (system prompt) and output schema.
The frontend triggers a skill (e.g. an "EOD" button) instead of holding one endless
chat, so each unit of work is bounded and structured.

Adding a skill = add a SkillDef to CANVAS_SKILLS. Nothing else changes: the route
`POST /canvas/skill/{name}` runs any registered skill against the project memory.

The first skill is `eod`: it turns the day's canvas work (history + memory) into an
end-of-day report written in CJ's EOD email style.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import requests

from src.integrations.openai_prompt_wizard import (
    OpenAIPromptWizardError,
    _extract_response_text,
    _usage_from_payload,
)

_OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
_SKILL_MODEL = "gpt-5.5"


@dataclass(frozen=True)
class SkillDef:
    name: str
    description: str
    system_prompt: str
    json_schema: dict[str, Any]


# ---------------------------------------------------------------------------
# EOD skill
# ---------------------------------------------------------------------------

_EOD_SYSTEM_PROMPT = """You write an end-of-day (EOD) report summarising a day of work on an AI image / lookdev project, in the user's established EOD email style.

You are given the day's work as structured data: a history of what was generated, the prompts used, any cost figures, the project memory (facts about the film), and any notes the user added. Summarise ONLY what is in that data. Never invent work, results, questions, costs, or people.

Style (this is a real work update to a team, not marketing):
- State facts plainly. "Result looked good", not "stunning photorealistic conversion". No hype, no selling.
- Cut details the team does not need (where the user was working from, precision levels, internal tooling names).
- Sections can be a single sentence. Do not pad. If it is short, it is short.
- Mention blockers honestly.
- Include a cost line only if cost figures were provided. Never estimate or invent cost.
- Do NOT tag or @mention anyone, and do NOT invent questions or action items for other people. The user adds those manually if they want them.
- Plain English. No corporate fluff. NO em dashes anywhere in the output (use commas, full stops, or colons).

Structure your output:
- tldr: one short line per section, in the same order as the sections. The count MUST equal the number of sections.
- sections: 2 to 5 of them. Each has a short title and a 1 to 4 sentence body. The last section is usually "Next Steps" or "Plan" and is forward-looking.
- cost_summary: a one-line cost note if cost data was provided, otherwise an empty string.
- suggested_sign_off: a short context-appropriate sign-off. "Have a great weekend" on a Friday, "Warm Wishes" as the default, something playful after a clearly big result.
- full_report: the assembled report as plain text: the date line, "TLDR:" with the numbered tldr lines, a separator line of dashes, then the numbered sections with their titles and bodies, then the cost line if any. Do NOT include a name/signature block (the app appends the user's signature). No markdown bold, just plain text and numbers."""

_EOD_JSON_SCHEMA: dict[str, Any] = {
    "type": "json_schema",
    "name": "canvas_eod_report",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "tldr": {"type": "array", "items": {"type": "string"}},
            "sections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                    },
                    "required": ["title", "body"],
                },
            },
            "cost_summary": {"type": "string"},
            "suggested_sign_off": {"type": "string"},
            "full_report": {"type": "string"},
        },
        "required": ["tldr", "sections", "cost_summary", "suggested_sign_off", "full_report"],
    },
}


CANVAS_SKILLS: dict[str, SkillDef] = {
    "eod": SkillDef(
        name="eod",
        description="End-of-day report: summarise the day's canvas work in CJ's EOD email style.",
        system_prompt=_EOD_SYSTEM_PROMPT,
        json_schema=_EOD_JSON_SCHEMA,
    ),
}


def list_canvas_skills() -> list[dict[str, str]]:
    """Skill metadata for the frontend to render buttons."""
    return [{"name": s.name, "description": s.description} for s in CANVAS_SKILLS.values()]


def get_canvas_skill(name: str) -> SkillDef | None:
    return CANVAS_SKILLS.get(name)


def run_canvas_skill(
    *,
    api_key: str,
    skill: SkillDef,
    payload: dict[str, Any],
    project_context: str | None = None,
    pricing_rates: dict[str, float] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run a skill: instructions = skill brain, input = payload + project context.

    Returns (result, usage). The result matches the skill's json_schema. Temperature
    is not sent (gpt-5.5 rejects it).
    """
    input_text_parts: list[str] = []
    if project_context and project_context.strip():
        input_text_parts.append("PROJECT MEMORY (ground truth):\n" + project_context.strip())
    input_text_parts.append("WORK DATA:\n" + json.dumps(payload, ensure_ascii=False))

    request_body: dict[str, Any] = {
        "model": _SKILL_MODEL,
        "instructions": skill.system_prompt,
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "\n\n".join(input_text_parts)}],
            }
        ],
        "text": {"format": skill.json_schema},
    }
    response = requests.post(
        _OPENAI_RESPONSES_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=request_body,
        timeout=120,
    )
    if response.status_code >= 400:
        detail = response.text[:2000]
        raise OpenAIPromptWizardError(f"OpenAI Responses API failed ({response.status_code}): {detail}")
    payload_json = response.json()
    text = _extract_response_text(payload_json)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise OpenAIPromptWizardError(f"Skill {skill.name} returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise OpenAIPromptWizardError(f"Skill {skill.name} returned an invalid response shape")
    return parsed, _usage_from_payload(payload_json, _SKILL_MODEL, pricing_rates)
