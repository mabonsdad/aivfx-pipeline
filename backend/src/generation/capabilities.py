from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

from src.contracts.video import LUMA_API_ALLOWED_MODE_IDS, VIDEO_MODEL_IDS

MODEL_FRAME_BUDGET_FPS = 24

LUMA_API_ALLOWED_MODES = frozenset(LUMA_API_ALLOWED_MODE_IDS)


@dataclass(frozen=True)
class VideoModelCapability:
    model: str
    label: str
    provider: str
    allowed_modes: frozenset[str]
    max_seconds: int | None = None
    min_seconds: int | None = None
    frame_budget_fps: int | None = None
    input_fps_cap: Fraction | None = None
    requires_prompt: bool = False
    required_prompt_markers: tuple[str, ...] = ()
    supports_chunked_generation: bool = False
    supports_extension: bool = False
    uses_source_video: bool = False
    first_frame_profile: str = "default_1080"
    source_video_profile: str | None = None
    provider_input_namespace: str | None = None


VIDEO_MODELS: dict[str, VideoModelCapability] = {
    "ray-3.2-720p": VideoModelCapability(
        model="ray-3.2-720p",
        label="Luma Ray 3.2 720p",
        provider="luma",
        allowed_modes=LUMA_API_ALLOWED_MODES,
        max_seconds=18,
        requires_prompt=True,
        supports_chunked_generation=True,
        supports_extension=True,
        uses_source_video=True,
        source_video_profile="default_source_video",
        provider_input_namespace="luma",
    ),
    "ray-3.2-1080p": VideoModelCapability(
        model="ray-3.2-1080p",
        label="Luma Ray 3.2 1080p",
        provider="luma",
        allowed_modes=LUMA_API_ALLOWED_MODES,
        max_seconds=18,
        requires_prompt=True,
        supports_chunked_generation=True,
        supports_extension=True,
        uses_source_video=True,
        source_video_profile="default_source_video",
        provider_input_namespace="luma",
    ),
    "gemini-omni-flash-preview": VideoModelCapability(
        model="gemini-omni-flash-preview",
        label="Gemini Omni Flash",
        provider="gemini",
        allowed_modes=frozenset(
            {
                "gemini_omni_start_video",
                "gemini_omni_start_end",
                "gemini_omni_start_only",
                "gemini_omni_edit_video",
            }
        ),
        max_seconds=10,
        min_seconds=3,
        input_fps_cap=Fraction(24, 1),
        requires_prompt=True,
        uses_source_video=False,
        first_frame_profile="runway_standard_720",
        source_video_profile="gemini_omni_video",
        provider_input_namespace="gemini",
    ),
    "runway-gen4.5": VideoModelCapability(
        model="runway-gen4.5",
        label="Runway Gen-4.5",
        provider="runway",
        allowed_modes=frozenset({"runway_i2v"}),
        max_seconds=10,
        first_frame_profile="runway_standard_720",
        provider_input_namespace="runway",
    ),
    "sora-2-image-to-video": VideoModelCapability(
        model="sora-2-image-to-video",
        label="Sora 2 Image to Video",
        provider="fal",
        allowed_modes=frozenset({"sora_i2v"}),
        max_seconds=10,
        min_seconds=4,
        requires_prompt=True,
        first_frame_profile="sora_i2v",
        provider_input_namespace="fal",
    ),
    "happy-horse-video-edit": VideoModelCapability(
        model="happy-horse-video-edit",
        label="Happy Horse 1.0 Video Edit",
        provider="fal",
        allowed_modes=frozenset({"happy_horse_video_edit"}),
        max_seconds=15,
        min_seconds=3,
        requires_prompt=True,
        required_prompt_markers=("@Image1",),
        uses_source_video=True,
        first_frame_profile="happy_horse_reference",
        provider_input_namespace="fal",
    ),
    "happy-horse-image-to-video": VideoModelCapability(
        model="happy-horse-image-to-video",
        label="Happy Horse 1.0 Image to Video",
        provider="fal",
        allowed_modes=frozenset({"happy_horse_i2v"}),
        max_seconds=15,
        min_seconds=3,
        requires_prompt=True,
        first_frame_profile="happy_horse_reference",
        provider_input_namespace="fal",
    ),
    "runway-gen4-aleph": VideoModelCapability(
        model="runway-gen4-aleph",
        label="Runway Aleph 2.0",
        provider="runway",
        allowed_modes=frozenset({"runway_aleph_v2v"}),
        max_seconds=10,
        requires_prompt=True,
        supports_chunked_generation=True,
        uses_source_video=True,
        first_frame_profile="runway_aleph",
        source_video_profile="default_source_video",
        provider_input_namespace="runway",
    ),
    "kling-2.6": VideoModelCapability(
        model="kling-2.6",
        label="Kling 2.6",
        provider="kling",
        allowed_modes=frozenset({"kling_start_only", "kling_start_end"}),
        max_seconds=10,
        provider_input_namespace="kling",
    ),
    "kling-o1": VideoModelCapability(
        model="kling-o1",
        label="Kling O1 Edit",
        provider="replicate",
        allowed_modes=frozenset({"kling_o1_video_edit"}),
        max_seconds=10,
        min_seconds=3,
        requires_prompt=True,
        required_prompt_markers=("<<<video_1>>>", "<<<image_1>>>"),
        supports_chunked_generation=True,
        supports_extension=True,
        uses_source_video=True,
        first_frame_profile="kling_edit",
        source_video_profile="kling_edit",
        provider_input_namespace="replicate",
    ),
    "kling-v3-omni-video": VideoModelCapability(
        model="kling-v3-omni-video",
        label="Kling v3 Omni Video",
        provider="replicate",
        allowed_modes=frozenset({"kling_v3_omni_video_edit"}),
        max_seconds=10,
        min_seconds=3,
        requires_prompt=True,
        required_prompt_markers=("<<<video_1>>>", "<<<image_1>>>"),
        supports_chunked_generation=True,
        supports_extension=True,
        uses_source_video=True,
        first_frame_profile="kling_edit",
        source_video_profile="kling_edit",
        provider_input_namespace="replicate",
    ),
    "seedance-2.0-reference-to-video": VideoModelCapability(
        model="seedance-2.0-reference-to-video",
        label="Seedance 2.0 Reference to Video",
        provider="fal",
        allowed_modes=frozenset({"seedance_reference_to_video"}),
        max_seconds=15,
        min_seconds=4,
        requires_prompt=True,
        required_prompt_markers=("@Video1", "@Image1"),
        supports_chunked_generation=True,
        supports_extension=True,
        uses_source_video=True,
        first_frame_profile="seedance_reference",
        source_video_profile="seedance_reference",
        provider_input_namespace="fal",
    ),
    "veo-3.1": VideoModelCapability(
        model="veo-3.1",
        label="Veo 3.1",
        provider="runware",
        allowed_modes=frozenset({"veo_start_only", "veo_start_end"}),
        max_seconds=8,
        frame_budget_fps=MODEL_FRAME_BUDGET_FPS,
        first_frame_profile="runway_standard_720",
        provider_input_namespace="runware",
    ),
    "veo-3.1-fast": VideoModelCapability(
        model="veo-3.1-fast",
        label="Veo 3.1 Fast",
        provider="runware",
        allowed_modes=frozenset({"veo_start_only", "veo_start_end"}),
        max_seconds=8,
        frame_budget_fps=MODEL_FRAME_BUDGET_FPS,
        first_frame_profile="runway_standard_720",
        provider_input_namespace="runware",
    ),
    "wan2.2-a14b": VideoModelCapability(
        model="wan2.2-a14b",
        label="Wan 2.2 A14B",
        provider="runware",
        allowed_modes=frozenset({"wan_a14b_i2v"}),
        max_seconds=5,
        first_frame_profile="runware_wan22",
        provider_input_namespace="runware",
    ),
    "wan2.2-animate": VideoModelCapability(
        model="wan2.2-animate",
        label="Wan 2.2 Animate",
        provider="runware",
        allowed_modes=frozenset({"wan_animate_replace"}),
        max_seconds=10,
        supports_chunked_generation=True,
        supports_extension=True,
        uses_source_video=True,
        first_frame_profile="runware_wan22",
        source_video_profile="default_source_video",
        provider_input_namespace="runware",
    ),
    "wan2.7-videoedit": VideoModelCapability(
        model="wan2.7-videoedit",
        label="Wan 2.7 VideoEdit",
        provider="replicate",
        allowed_modes=frozenset({"wan27_video_edit"}),
        max_seconds=10,
        min_seconds=2,
        input_fps_cap=Fraction(24, 1),
        requires_prompt=True,
        supports_chunked_generation=True,
        supports_extension=True,
        uses_source_video=True,
        first_frame_profile="wan27_edit",
        source_video_profile="wan27_edit",
        provider_input_namespace="replicate",
    ),
    "wan2.7-i2v": VideoModelCapability(
        model="wan2.7-i2v",
        label="Wan 2.7 Image to Video",
        provider="replicate",
        allowed_modes=frozenset({"wan27_i2v_start_only", "wan27_i2v_start_end"}),
        max_seconds=10,
        min_seconds=2,
        requires_prompt=True,
        first_frame_profile="wan27_edit",
        provider_input_namespace="replicate",
    ),
    "ltx-2.3-pro": VideoModelCapability(
        model="ltx-2.3-pro",
        label="LTX 2.3 Pro",
        provider="replicate",
        allowed_modes=frozenset({"ltx23_i2v_start_end"}),
        max_seconds=10,
        min_seconds=6,
        requires_prompt=True,
        first_frame_profile="ltx23_i2v",
        provider_input_namespace="replicate",
    ),
}

if frozenset(VIDEO_MODELS.keys()) != frozenset(VIDEO_MODEL_IDS):
    missing = sorted(set(VIDEO_MODEL_IDS) - set(VIDEO_MODELS))
    extra = sorted(set(VIDEO_MODELS) - set(VIDEO_MODEL_IDS))
    raise RuntimeError(f"Video contract mismatch in capabilities: missing={missing}, extra={extra}")


def get_video_model_capability(model: str) -> VideoModelCapability:
    capability = VIDEO_MODELS.get(model)
    if capability is None:
        raise ValueError(f"Unsupported video model: {model}")
    return capability


def get_video_model_label(model: str) -> str:
    capability = VIDEO_MODELS.get(model)
    return capability.label if capability else model


def get_video_model_provider(model: str) -> str:
    return get_video_model_capability(model).provider


def supports_chunked_generation(model: str) -> bool:
    return get_video_model_capability(model).supports_chunked_generation


def supports_generation_extension(model: str) -> bool:
    return get_video_model_capability(model).supports_extension


def validate_video_model_mode(model: str, mode: str) -> None:
    capability = get_video_model_capability(model)
    if mode not in capability.allowed_modes:
        allowed_values = ", ".join(sorted(capability.allowed_modes))
        raise ValueError(f"{capability.label} requires one of: {allowed_values}.")


def validate_video_model_prompt(model: str, prompt: str | None, *, prompt_label: str = "prompt") -> None:
    capability = get_video_model_capability(model)
    if capability.requires_prompt and not prompt:
        raise ValueError(f"{capability.label} requires a prompt.")
    if not prompt or not capability.required_prompt_markers:
        return
    missing_refs = [marker for marker in capability.required_prompt_markers if marker not in prompt]
    if missing_refs:
        raise ValueError(f"{capability.label} {prompt_label} must reference {' and '.join(missing_refs)}.")


def resolve_video_model_limit_error(
    *,
    model: str,
    duration_seconds: float,
    duration_frames: int,
    source_fps: Fraction,
    source_label: str = "source segment",
    selected_label: str = "Selected segment",
) -> str | None:
    capability = get_video_model_capability(model)
    if capability.max_seconds is None:
        return None
    max_frames = int(round(capability.max_seconds * float(capability.frame_budget_fps or source_fps)))
    over_frames = duration_frames > max_frames
    over_seconds = duration_seconds > float(capability.max_seconds) + 1e-6
    under_seconds = capability.min_seconds is not None and duration_seconds + 1e-6 < float(capability.min_seconds)
    if under_seconds:
        return (
            f"{capability.label} requires a {source_label} between {capability.min_seconds}s and "
            f"{capability.max_seconds}s. {selected_label} is {duration_seconds:.2f}s."
        )
    if not over_frames and not over_seconds:
        return None
    if (
        capability.frame_budget_fps is not None
        and over_frames
        and abs(float(source_fps) - capability.frame_budget_fps) > 1e-3
    ):
        return (
            f"{capability.label} allows up to {capability.max_seconds}s at {capability.frame_budget_fps}fps "
            f"({max_frames} frames). {selected_label} is {duration_frames} frames / {duration_seconds:.2f}s "
            f"at {float(source_fps):.2f}fps, so it exceeds this model's frame budget."
        )
    return (
        f"{capability.label} allows up to {capability.max_seconds}s. {selected_label} is "
        f"{duration_frames} frames / {duration_seconds:.2f}s, which is over the limit."
    )


def resolve_video_model_provider_fps(
    *,
    model: str,
    source_fps: Fraction,
    preserve_frames: bool,
) -> tuple[Fraction, str]:
    capability = get_video_model_capability(model)
    cap = capability.input_fps_cap
    if cap is None or float(source_fps) <= float(cap):
        return source_fps, "source_fps"
    return cap, "preserve_frames_retime" if preserve_frames else "resample_to_model_fps"
