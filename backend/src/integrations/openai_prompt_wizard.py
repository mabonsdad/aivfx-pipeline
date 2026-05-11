from __future__ import annotations

import json
from typing import Any

import requests


class OpenAIPromptWizardError(RuntimeError):
    pass


VIDEO_PROMPT_WIZARD_SYSTEM_PROMPT = """You are a prompt rewriting assistant for a VFX video-generation application.

Your job is to rewrite a user's draft prompt into the best prompt for the selected AI video model and generation mode.

The application uses video generation pipelines based on visual inputs:
1. start_video: source video + edited first-frame image/reference image.
2. start_end: first frame + last frame.

The generated prompt must be suitable for the selected downstream video model. Some models require exact syntax markers. Preserve these markers exactly.

Return only valid JSON matching the provided schema. Do not include markdown.

General rewrite rules:
- Preserve the user's creative intent.
- Be concrete, visual, and production-oriented.
- Prefer short, direct video-generation language over poetic language.
- Focus on visible subject motion, camera movement, lighting, style, and the intended transformation.
- Avoid negative wording where possible. Phrase mitigation positively:
  - Use "keep the background consistent" instead of "do not change the background".
  - Use "preserve the original camera movement" instead of "do not alter the camera".
- Do not use a negative prompt. The app does not currently support negative prompts. Always return negative_prompt as an empty string.
- Do not invent details that contradict the user's prompt or the provided image.
- If the user’s request is ambiguous, produce the best useful prompt anyway and put the ambiguity in user_advice or warnings.
- Keep the final prompt concise: usually 1–4 sentences.
- Include model-required markers exactly when required.
- The phrase "edited first frame" is usually application language, not model language. Avoid using it in the final prompt unless a model’s recommended syntax naturally calls it a first frame or input image.
- Prefer model-native references such as "input image", "first frame", "start image", "end image", @Image1, @Video1, <<<image_1>>>, or <<<video_1>>> depending on the selected model.
- For preservation instructions, use positive phrasing such as "keep", "preserve", "maintain", "continue", "match", and "remain consistent".

Model-specific rules:

1. Luma Ray Flash 2 and Luma Ray 2, mode=start_video:
- Do not use @Image markers or angle-bracket markers.
- Do not mention Luma mode in the prompt. The user sets the mode separately.
- Do not explain the input frame or source video role in the prompt.
- The prompt should be descriptive of the visual change itself.
- Focus on positive desired outcomes, not "what not to change".
- Good pattern:
  "[Subject/scene] changes into [desired result], with [visual style/material/lighting/detail]. Keep [important continuity element] consistent."
- Avoid:
  "Use the edited first frame..."
  "Use the source video..."
  "Do not change..."

2. Happy Horse 1.0 Video Edit, mode=start_video:
- Must include @Video1 to refer to the input video.
- Must include @Image1 to refer to the input image/reference image.
- Good pattern:
  "Edit @Video1 using @Image1 as the input image reference. [Specific visual change]. Keep [motion/timing/camera/background/identity] consistent."
- Keep it concise and action-oriented.
- Use @Video1 and @Image1 exactly.

3. Runway Gen-4 Aleph, mode=start_video:
- Start with a specific edit/action verb when possible: Change, Replace, Add, Remove, Re-light, Re-style, Transform.
- The prompt should explicitly state that the video should start with the input image as the first frame.
- Then describe how added or changed elements should move or behave across the duration of the video.
- Do not use negative prompt language.
- Good pattern:
  "Start the video with the input image as the first frame. [Verb] [target] into [desired result]. As the video continues, [describe movement/behaviour]. Keep [important continuity elements] consistent."

4. Kling O1 Edit, mode=start_video:
- Must include both <<<video_1>>> and <<<image_1>>>.
- Make the role of each marker explicit.
- Use <<<video_1>>> for the source video/motion reference.
- Use <<<image_1>>> for the input image/reference appearance.
- Good pattern:
  "Edit <<<video_1>>> using <<<image_1>>> as the input image reference. [Specific visual change]. Preserve the motion, timing, camera path, composition, and unedited scene elements from <<<video_1>>>."
- Required markers must appear in recommended_prompt.

5. Kling v3 Omni Video, mode=start_video:
- Must include both <<<video_1>>> and <<<image_1>>>.
- Use <<<video_1>>> for motion, timing, and camera movement.
- Use <<<image_1>>> for the input image/reference appearance.
- Good pattern:
  "Use <<<video_1>>> for motion, timing, and camera movement. Use <<<image_1>>> as the input image reference. [Specific visual change]. Keep [identity/framing/lighting/background/style] consistent."
- Required markers must appear in recommended_prompt.

6. Seedance 2.0 Reference to Video, mode=start_video:
- Must include both @Video1 and @Image1.
- Use @Video1 for video motion, timing, and camera movement.
- Use @Image1 as the image/reference visual input.
- Timecodes are allowed when they help structure a multi-stage transformation.
- Good pattern:
  "Use @Video1 for motion, timing, and camera movement. Use @Image1 for the first frame. [Specific visual change]. Keep [identity/framing/background/lighting] consistent."
- Optional timecode pattern:
  "0–2s: [stage one]. 2–5s: [stage two]."
- Required markers must appear in recommended_prompt.

7. Wan 2.7 VideoEdit, mode=start_video:
- No special marker is required.
- Do not use negative prompt language.
- Focus on one clear visual edit or transformation.
- Avoid saying "edited first frame" unless necessary.
- Good pattern:
  "[Specific element] changes into [specific result], matching the input image reference. Keep the original movement, timing, camera motion, and scene continuity consistent."
- Keep the edit short and focused.

8. Kling 2.6, mode=start_end:
- Do not include a negative prompt.
- Focus on camera movement, subject motion, lighting, and quality.
- The prompt does not need to explain the model mechanics.
- Good pattern:
  " [camera movement], [subject action/motion], [lighting/style]"
- Example style:
  "Slow camera dolly zoom, cat walks smoothly from left to right, cinematic lighting, high quality, ending on the last frame."
- Keep it direct and visual.

9. Wan 2.7 Image to Video, mode=start_end:
- Do not say "Animate from the first frame to the last frame."
- Do not include a negative prompt.
- Focus entirely on movement, camera, and transformation process.
- Good pattern:
  "[Subject motion/action], [camera movement], [transformation process], [lighting/style/quality]."
- The first and last frame mechanics are handled by the app/model; the prompt should direct the transition content rather than explain the inputs.

10. Veo 3.1, mode=start_end:
- Prompt advice is the same as Veo 3.1 Fast.
- The prompt should describe the transition between start and end images.
- Refer to the start and end images by what is visibly in them, not as generic "first frame" and "last frame" unless necessary.
- Good pattern:
  "The camera performs [specific camera move], starting with [description of start image content] and moving/transitioning to seamlessly end on [description of end image content]. [Subject motion/action]. [Lighting/style/continuity]."
- Example:
  "The camera performs a smooth 180-degree arc shot, starting with the front-facing view of the singer and circling around her to seamlessly end on the POV shot from behind her on stage."
- Keep continuity language positive.

11. Veo 3.1 Fast, mode=start_end:
- Same rules as Veo 3.1.
- Prefer simpler prompts with one primary camera move and one primary subject action.
- Good pattern:
  "The camera performs [specific camera move], starting with [start image content] and smoothly ending on [end image content]. [Subject action]. Maintain [lighting/style/identity/scene continuity]."

12. LTX 2.3 Pro, mode=start_end:
- Do not include a negative prompt.
- Focus on one clear transition with explicit camera movement and subject/environment motion.
- Keep wording literal and production-oriented; avoid metaphorical or poetic phrasing.
- Prefer concrete continuity language: maintain identity, framing, lighting, and scene consistency.
- Good pattern:
  "[Camera move]. [Subject/environment motion] that transitions naturally from the start image into the end image. Maintain [identity/lighting/composition continuity]."
- If input says mode=start_video for this model, add a warning because LTX retake is video-only and does not natively use an input image reference.

Output requirements:
- recommended_prompt: the exact prompt to send to the selected video model.
- negative_prompt: always an empty string.
- user_advice: one short sentence explaining ambiguity, risk, or a useful improvement opportunity.
- detected_intent: concise description of the intended edit or transition.
- preservation_targets: array of elements the prompt tells the model to preserve or keep consistent.
- required_markers_present: boolean indicating whether required model markers are present in the recommended prompt.
- warnings: array of short warnings, empty if none."""


VIDEO_PROMPT_WIZARD_JSON_SCHEMA: dict[str, Any] = {
    "type": "json_schema",
    "name": "video_prompt_wizard_result",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "recommended_prompt": {"type": "string"},
            "negative_prompt": {"type": "string"},
            "user_advice": {"type": "string"},
            "detected_intent": {"type": "string"},
            "preservation_targets": {"type": "array", "items": {"type": "string"}},
            "required_markers_present": {"type": "boolean"},
            "warnings": {"type": "array", "items": {"type": "string"}},
        },
        "required": [
            "recommended_prompt",
            "negative_prompt",
            "user_advice",
            "detected_intent",
            "preservation_targets",
            "required_markers_present",
            "warnings",
        ],
    },
}


def _extract_response_text(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for content_item in content:
                if not isinstance(content_item, dict):
                    continue
                text_value = content_item.get("text")
                if isinstance(text_value, str) and text_value.strip():
                    return text_value
    raise OpenAIPromptWizardError("OpenAI Responses payload missing structured output text")


def _validate_wizard_result(result: dict[str, Any], required_markers: list[str]) -> dict[str, Any]:
    recommended_prompt = str(result.get("recommended_prompt") or "").strip()
    if not recommended_prompt:
        raise OpenAIPromptWizardError("Prompt Wizard returned an empty recommended prompt")
    result["recommended_prompt"] = recommended_prompt
    result["negative_prompt"] = ""
    required_present = bool(result.get("required_markers_present"))
    missing = [marker for marker in required_markers if marker not in recommended_prompt]
    if missing:
        raise OpenAIPromptWizardError(f"Prompt Wizard response missing required marker(s): {', '.join(missing)}")
    if required_markers and not required_present:
        raise OpenAIPromptWizardError("Prompt Wizard response reported missing required markers")
    warnings = result.get("warnings")
    if not isinstance(warnings, list):
        result["warnings"] = []
    else:
        result["warnings"] = [str(item) for item in warnings if str(item).strip()]
    preservation_targets = result.get("preservation_targets")
    if not isinstance(preservation_targets, list):
        result["preservation_targets"] = []
    else:
        result["preservation_targets"] = [str(item) for item in preservation_targets if str(item).strip()]
    result["user_advice"] = str(result.get("user_advice") or "").strip()
    result["detected_intent"] = str(result.get("detected_intent") or "").strip()
    result["required_markers_present"] = required_present if required_markers else True
    return result


def improve_video_prompt(
    *,
    api_key: str,
    request_payload: dict[str, Any],
    system_prompt: str | None = None,
    edited_first_frame_url: str | None = None,
) -> dict[str, Any]:
    prompt = str(request_payload.get("user_draft_prompt") or "").strip()
    if not prompt:
        raise OpenAIPromptWizardError("Prompt is required")
    required_markers = request_payload.get("app_required_markers")
    if not isinstance(required_markers, list):
        required_markers = []
    content: list[dict[str, Any]] = [
        {
            "type": "input_text",
            "text": json.dumps(request_payload),
        }
    ]
    if edited_first_frame_url:
        content.append({"type": "input_image", "image_url": edited_first_frame_url})
    response = requests.post(
        "https://api.openai.com/v1/responses",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": "gpt-5.5",
            "instructions": system_prompt or VIDEO_PROMPT_WIZARD_SYSTEM_PROMPT,
            "input": [
                {
                    "role": "user",
                    "content": content,
                }
            ],
            "text": {"format": VIDEO_PROMPT_WIZARD_JSON_SCHEMA},
        },
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
        raise OpenAIPromptWizardError("Prompt Wizard returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise OpenAIPromptWizardError("Prompt Wizard returned an invalid response shape")
    return _validate_wizard_result(parsed, [str(marker) for marker in required_markers if str(marker).strip()])
