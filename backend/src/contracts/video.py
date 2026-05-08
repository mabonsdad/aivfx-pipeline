from __future__ import annotations

# Canonical video-generation identifiers shared between backend validation
# and generated frontend contract types.
VIDEO_MODEL_IDS: tuple[str, ...] = (
    "ray-2",
    "ray-flash-2",
    "runway-gen4.5",
    "sora-2-image-to-video",
    "happy-horse-video-edit",
    "happy-horse-image-to-video",
    "runway-gen4-aleph",
    "kling-2.6",
    "kling-o1",
    "kling-v3-omni-video",
    "seedance-2.0-reference-to-video",
    "veo-3.1",
    "veo-3.1-fast",
    "wan2.2-a14b",
    "wan2.2-animate",
    "wan2.7-videoedit",
    "wan2.7-i2v",
)

VIDEO_MODE_IDS: tuple[str, ...] = (
    "adhere_1",
    "adhere_2",
    "adhere_3",
    "flex_1",
    "flex_2",
    "flex_3",
    "reimagine_1",
    "reimagine_2",
    "reimagine_3",
    "runway_i2v",
    "sora_i2v",
    "happy_horse_video_edit",
    "happy_horse_i2v",
    "runway_aleph_v2v",
    "kling_start_end",
    "kling_start_only",
    "veo_start_end",
    "veo_start_only",
    "wan_a14b_i2v",
    "wan_animate_replace",
    "kling_o1_video_edit",
    "kling_v3_omni_video_edit",
    "seedance_reference_to_video",
    "wan27_video_edit",
    "wan27_i2v_start_only",
    "wan27_i2v_start_end",
)

LUMA_API_ALLOWED_MODE_IDS: tuple[str, ...] = (
    "adhere_1",
    "adhere_2",
    "adhere_3",
    "flex_1",
    "flex_2",
    "flex_3",
    "reimagine_1",
    "reimagine_2",
    "reimagine_3",
)

FULL_EDIT_MODEL_IDS: tuple[str, ...] = (
    "nano_banana",
    "nano_banana_pro",
    "chatgpt",
    "chatgpt_latest",
    "luma_uni_1",
    "luma_uni_1_max",
    "luma_uni_1_1",
)

PATCH_EDIT_MODEL_IDS: tuple[str, ...] = (
    "nano_banana_pro",
    "chatgpt",
    "chatgpt_latest",
    "runware_flux_fill",
    "runware_ace_pp",
)

REPLICATE_KLING_MODE_IDS: tuple[str, ...] = ("std", "pro")
REPLICATE_KLING_V3_MODE_IDS: tuple[str, ...] = ("standard", "pro")
WAN27_RESOLUTION_IDS: tuple[str, ...] = ("720p", "1080p")
HAPPY_HORSE_RESOLUTION_IDS: tuple[str, ...] = ("720p", "1080p")
SORA2_RESOLUTION_IDS: tuple[str, ...] = ("auto", "720p", "1080p")
