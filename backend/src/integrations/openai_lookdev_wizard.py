"""Lookdev / image prompt rewriting for the canvas workflow.

This reuses the existing OpenAI Responses engine (``improve_video_prompt``) unchanged.
The only thing that differs from the video Prompt Wizard is the system prompt and the
fact that there are no required model markers, so no marker validation runs. Same
OpenAI key (from AWS Secrets), same auth, same JSON schema for the result.

Kept in its own file so the canvas/lookdev concern never edits the video wizard.
"""

from __future__ import annotations

from typing import Any

from src.integrations.openai_prompt_wizard import improve_video_prompt

LOOKDEV_PROMPT_WIZARD_SYSTEM_PROMPT = """You are a prompt rewriting assistant for an AI image / lookdev application.

Your job is to rewrite a user's draft into the best prompt for a text-to-image or image-to-image lookdev generation. This is for establishing the look of a shot: a single still frame, not a video.

Return only valid JSON matching the provided schema. Do not include markdown.

There are no model markers for this surface. Never add tokens like @Image1, @Video1, <<<image_1>>>, or <<<video_1>>>. Always return required_markers_present as true and negative_prompt as an empty string (the app does not use negative prompts).

Rewrite rules:
- Preserve the user's creative intent. Do not invent details that contradict the user's draft or the provided reference image.
- Be concrete and visual. Prefer specific, observable description over poetic or abstract language.
- Cover the elements that decide a look, in roughly this order when relevant: subject and action, setting and environment, composition and framing, lens and camera angle, lighting (direction, quality, colour), materials and texture, colour palette, overall style and mood.
- Use positive phrasing for things to keep. Say "keep the character's face and outfit consistent" rather than "do not change the character".
- If a reference image is provided, treat it as the look to match or evolve, and say plainly what should carry over (identity, palette, lighting, style) and what should change.
- Keep the final prompt concise: usually 1 to 4 sentences. Front-load the most important visual information.
- If the user's request is ambiguous, produce the best useful prompt anyway and put the ambiguity in user_advice or warnings.

Output requirements:
- recommended_prompt: the exact prompt to send to the image / lookdev model.
- negative_prompt: always an empty string.
- user_advice: one short sentence on ambiguity, risk, or a useful improvement.
- detected_intent: concise description of the look being targeted.
- preservation_targets: array of elements the prompt tells the model to keep consistent (identity, palette, lighting, style, framing).
- required_markers_present: always true.
- warnings: array of short warnings, empty if none."""


def improve_lookdev_prompt(
    *,
    api_key: str,
    user_draft_prompt: str,
    user_visible_model_name: str = "Lookdev",
    aspect_ratio: str | None = None,
    reference_image_url: str | None = None,
    system_prompt: str | None = None,
    pricing_rates: dict[str, float] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Rewrite a lookdev/image draft prompt via the shared OpenAI engine.

    No required markers are passed, so the engine skips all video-marker validation.
    Temperature is intentionally not forwarded: the underlying model (gpt-5.5, a
    reasoning model on the Responses API) rejects the temperature parameter.
    Returns (result, usage) where usage holds token counts + estimated cost.
    """
    request_payload: dict[str, Any] = {
        "user_draft_prompt": user_draft_prompt,
        "app_required_markers": [],
        "supports_negative_prompt": False,
        "mode": "lookdev_image",
        "aspect_ratio": aspect_ratio,
        "user_visible_model_name": user_visible_model_name,
    }
    return improve_video_prompt(
        api_key=api_key,
        request_payload=request_payload,
        system_prompt=system_prompt or LOOKDEV_PROMPT_WIZARD_SYSTEM_PROMPT,
        edited_first_frame_url=reference_image_url,
        pricing_rates=pricing_rates,
        return_usage=True,
    )
