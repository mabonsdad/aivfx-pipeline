from __future__ import annotations

import math
from copy import deepcopy
from typing import Any

ADMIN_PRICING_CONFIG_KEY = "admin/pricing_config.json"

_ALLOWED_BILLING_UNITS = {
    "per_1m_tokens",
    "per_image",
    "per_second",
    "per_million_pixels",
    "provider_example",
    "mixed",
}

_DEFAULT_PRICING_ENTRIES: list[dict[str, Any]] = [
    {
        "pricingId": "openai.gpt-5.5.responses",
        "label": "OpenAI GPT-5.5 (Responses API / prompt wizard)",
        "provider": "OpenAI",
        "appModelId": "gpt-5.5",
        "providerModel": "gpt-5.5",
        "category": "prompt_rewrite",
        "billingUnit": "per_1m_tokens",
        "rates": {
            "input_per_1m_tokens_usd": 5.0,
            "cached_input_per_1m_tokens_usd": 0.5,
            "output_per_1m_tokens_usd": 30.0,
        },
        "assumptions": "Official OpenAI API pricing for GPT-5.5 on the Responses API.",
        "sourceUrl": "https://openai.com/api/pricing/",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Use this for both the video prompt wizard and canvas/lookdev prompt wizard token-cost estimation.",
    },
    {
        "pricingId": "openai.gpt-image-1.5",
        "label": "OpenAI GPT-Image 1.5",
        "provider": "OpenAI",
        "appModelId": "chatgpt",
        "providerModel": "gpt-image-1.5",
        "category": "image_generation",
        "billingUnit": "per_1m_tokens",
        "rates": {
            "text_input_per_1m_tokens_usd": 5.0,
            "text_cached_input_per_1m_tokens_usd": 1.25,
            "text_output_per_1m_tokens_usd": 10.0,
            "image_input_per_1m_tokens_usd": 8.0,
            "image_cached_input_per_1m_tokens_usd": 2.0,
            "image_output_per_1m_tokens_usd": 32.0,
        },
        "assumptions": "OpenAI image-token pricing from the official API pricing docs.",
        "sourceUrl": "https://developers.openai.com/api/docs/pricing",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Token-based image pricing rather than a flat per-image fee.",
    },
    {
        "pricingId": "openai.chatgpt-image-latest",
        "label": "OpenAI ChatGPT Image Latest",
        "provider": "OpenAI",
        "appModelId": "chatgpt_latest",
        "providerModel": "chatgpt-image-latest",
        "category": "image_generation",
        "billingUnit": "per_1m_tokens",
        "rates": {
            "text_input_per_1m_tokens_usd": 5.0,
            "text_cached_input_per_1m_tokens_usd": 1.25,
            "text_output_per_1m_tokens_usd": 10.0,
            "image_input_per_1m_tokens_usd": 8.0,
            "image_cached_input_per_1m_tokens_usd": 2.0,
            "image_output_per_1m_tokens_usd": 32.0,
        },
        "assumptions": "Official OpenAI model pricing page for chatgpt-image-latest.",
        "sourceUrl": "https://developers.openai.com/api/docs/models/chatgpt-image-latest",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Same token schedule currently published for GPT-Image 1.5 style image generation.",
    },
    {
        "pricingId": "google.gemini-2.5-flash-image",
        "label": "Google Gemini 2.5 Flash Image (Nano Banana)",
        "provider": "Google",
        "appModelId": "nano_banana",
        "providerModel": "gemini-2.5-flash-image",
        "category": "image_generation",
        "billingUnit": "mixed",
        "rates": {
            "input_per_1m_tokens_usd": 0.3,
            "image_output_per_1m_tokens_usd": 30.0,
            "image_output_per_image_1024_usd": 0.039,
        },
        "assumptions": "Standard Gemini API pricing tier; 1024x1024 image example from the official pricing page.",
        "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Google publishes image output both as per-image-token pricing and an approximate per-image example.",
    },
    {
        "pricingId": "google.gemini-3-pro-image-preview",
        "label": "Google Gemini 3 Pro Image Preview (Nano Banana Pro)",
        "provider": "Google",
        "appModelId": "nano_banana_pro",
        "providerModel": "gemini-3-pro-image-preview",
        "category": "image_generation",
        "billingUnit": "mixed",
        "rates": {
            "input_per_1m_tokens_usd": 3.6,
            "text_output_per_1m_tokens_usd": 21.6,
            "image_output_per_1m_tokens_usd": 216.0,
            "image_output_per_image_1024_usd": 0.134,
        },
        "assumptions": "Official Gemini API pricing page; per-image example is the published 1024x1024 to 2048x2048 band example.",
        "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Higher quality preview model; Google publishes a much higher image-output rate than Nano Banana.",
    },
    {
        "pricingId": "luma.uni-1",
        "label": "Luma Uni-1",
        "provider": "Luma",
        "appModelId": "luma_uni_1",
        "providerModel": "uni-1",
        "category": "image_generation",
        "billingUnit": "per_image",
        "rates": {
            "text_to_image_per_image_usd": 0.0404,
            "image_edit_per_image_usd": 0.0434,
            "image_reference_1_per_image_usd": 0.0434,
            "image_reference_2_per_image_usd": 0.0464,
        },
        "assumptions": "Official Luma Agents per-image pricing.",
        "sourceUrl": "https://docs.agents.lumalabs.ai/guides/pricing/",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Extra reference images increase cost; the registry stores the common cases used in-app.",
    },
    {
        "pricingId": "luma.uni-1-max",
        "label": "Luma Uni-1 Max",
        "provider": "Luma",
        "appModelId": "luma_uni_1_max",
        "providerModel": "uni-1-max",
        "category": "image_generation",
        "billingUnit": "per_image",
        "rates": {
            "text_to_image_per_image_usd": 0.1,
            "image_edit_per_image_usd": 0.103,
            "image_reference_1_per_image_usd": 0.103,
            "image_reference_2_per_image_usd": 0.106,
        },
        "assumptions": "Official Luma Agents Uni-1 Max per-image pricing.",
        "sourceUrl": "https://docs.agents.lumalabs.ai/guides/pricing/",
        "sourceCheckedAt": "2026-06-20",
        "notes": "2K output tier; extra reference images add $0.003 each according to Luma's pricing page.",
    },
    {
        "pricingId": "luma.ray-2.video-modify",
        "label": "Luma Ray 2 video modify",
        "provider": "Luma",
        "appModelId": "ray-2",
        "providerModel": "ray-2",
        "category": "video_generation",
        "billingUnit": "per_million_pixels",
        "rates": {
            "output_per_million_pixels_usd": 0.01582,
        },
        "assumptions": "Dream Machine modify-video pricing is published per million pixels rather than per second.",
        "sourceUrl": "https://docs.lumalabs.ai/docs/modify-video",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Luma's example on the same page gives about $1.75 for a 720p 5s 16:9 request.",
    },
    {
        "pricingId": "luma.ray-flash-2.video-modify",
        "label": "Luma Ray Flash 2 video modify",
        "provider": "Luma",
        "appModelId": "ray-flash-2",
        "providerModel": "ray-flash-2",
        "category": "video_generation",
        "billingUnit": "per_million_pixels",
        "rates": {
            "output_per_million_pixels_usd": 0.00544,
        },
        "assumptions": "Dream Machine modify-video pricing is published per million pixels rather than per second.",
        "sourceUrl": "https://docs.lumalabs.ai/docs/modify-video",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Luma's example on the same page gives about $0.60 for a 720p 5s 16:9 request.",
    },
    {
        "pricingId": "runway.gen4.5",
        "label": "Runway Gen-4.5",
        "provider": "Runway",
        "appModelId": "runway-gen4.5",
        "providerModel": "gen4.5",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_1080p": 0.12,
        },
        "assumptions": "Runway API pricing page quotes 12 credits/sec; registry treats one credit as $0.01.",
        "sourceUrl": "https://docs.dev.runwayml.com/guides/pricing/",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Credit-to-USD conversion is inferred from Runway's public API pricing presentation and calculator examples.",
    },
    {
        "pricingId": "runway.gen4-aleph",
        "label": "Runway Gen-4 Aleph",
        "provider": "Runway",
        "appModelId": "runway-gen4-aleph",
        "providerModel": "gen4_aleph",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_1080p": 0.15,
        },
        "assumptions": "Runway API pricing page quotes 15 credits/sec; registry treats one credit as $0.01.",
        "sourceUrl": "https://docs.dev.runwayml.com/guides/pricing/",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Model is deprecated upstream but still appears in this app.",
    },
    {
        "pricingId": "runway.act-two",
        "label": "Runway Act-Two",
        "provider": "Runway",
        "appModelId": "runway_act_two",
        "providerModel": "act_two",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_1080p": 0.05,
        },
        "assumptions": "Runway API pricing page quotes 5 credits/sec; registry treats one credit as $0.01.",
        "sourceUrl": "https://docs.dev.runwayml.com/guides/pricing/",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Used in Character Animate pose-video mode.",
    },
    {
        "pricingId": "fal.happy-horse.video-edit",
        "label": "fal.ai Happy Horse video edit",
        "provider": "fal.ai",
        "appModelId": "happy-horse-video-edit",
        "providerModel": "alibaba/happy-horse/video-edit",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_720p": 0.14,
            "output_per_second_usd_1080p": 0.28,
        },
        "assumptions": "fal.ai publishes explicit 720p and 1080p per-second pricing on the model page.",
        "sourceUrl": "https://fal.ai/models/alibaba/happy-horse/video-edit",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Use the 1080p rate for default cost assumptions.",
    },
    {
        "pricingId": "fal.happy-horse.image-to-video",
        "label": "fal.ai Happy Horse image-to-video",
        "provider": "fal.ai",
        "appModelId": "happy-horse-image-to-video",
        "providerModel": "alibaba/happy-horse/image-to-video",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_720p": 0.14,
            "output_per_second_usd_1080p": 0.28,
        },
        "assumptions": "fal.ai publishes explicit 720p and 1080p per-second pricing on the model page.",
        "sourceUrl": "https://fal.ai/models/alibaba/happy-horse/image-to-video",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Used in Previz video generation.",
    },
    {
        "pricingId": "fal.seedance-2.0.reference-to-video",
        "label": "fal.ai Seedance 2.0 reference-to-video",
        "provider": "fal.ai",
        "appModelId": "seedance-2.0-reference-to-video",
        "providerModel": "bytedance/seedance-2.0/reference-to-video",
        "category": "video_generation",
        "billingUnit": "mixed",
        "rates": {
            "output_per_second_usd_720p": 0.3034,
            "output_per_second_usd_1080p": 0.682,
            "request_per_1000_tokens_usd": 0.014,
            "video_input_multiplier": 0.6,
            "output_per_second_usd_1080p_with_video_input": 0.4092,
        },
        "assumptions": "fal.ai publishes 1080p per-second video output plus a separate request-token charge; video-input requests multiply the video price by 0.6.",
        "sourceUrl": "https://fal.ai/models/bytedance/seedance-2.0/reference-to-video",
        "sourceCheckedAt": "2026-06-20",
        "notes": "This entry is used in Source Video, Character Animate, and Previz surfaces.",
    },
    {
        "pricingId": "fal.sora-2.image-to-video.pro",
        "label": "fal.ai Sora 2 image-to-video pro",
        "provider": "fal.ai",
        "appModelId": "sora-2-image-to-video",
        "providerModel": "fal-ai/sora-2/image-to-video/pro",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_720p": 0.3,
            "output_per_second_usd_1080p": 0.7,
        },
        "assumptions": "Registry uses fal.ai's published true-1080p price rather than the cheaper legacy-1080p tier.",
        "sourceUrl": "https://fal.ai/models/fal-ai/sora-2/image-to-video/pro",
        "sourceCheckedAt": "2026-06-20",
        "notes": "fal.ai also lists a legacy 1080p rate of $0.50/sec; this app should assume true 1080p.",
    },
    {
        "pricingId": "fal.omnihuman.v1.5",
        "label": "fal.ai OmniHuman v1.5",
        "provider": "fal.ai",
        "appModelId": "omnihuman_v1_5",
        "providerModel": "fal-ai/bytedance/omnihuman/v1.5",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_1080p": 0.16,
        },
        "assumptions": "fal.ai's model page publishes a single per-second request price.",
        "sourceUrl": "https://fal.ai/models/fal-ai/bytedance/omnihuman/v1.5",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Model page currently shows $0.16/sec.",
    },
    {
        "pricingId": "fal.topaz.upscale.video",
        "label": "fal.ai Topaz video upscale",
        "provider": "fal.ai",
        "appModelId": "topaz_upscale_video",
        "providerModel": "fal-ai/topaz/upscale/video",
        "category": "video_postprocess",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_up_to_720p": 0.01,
            "output_per_second_usd_720p_to_1080p": 0.02,
            "output_per_second_usd_above_1080p": 0.08,
        },
        "assumptions": "Registry assumes the common 720p-to-1080p upscale path for the app's cost rollups.",
        "sourceUrl": "https://fal.ai/models/fal-ai/topaz/upscale/video",
        "sourceCheckedAt": "2026-06-20",
        "notes": "60fps doubles cost according to fal.ai; Gaia 2 is cheaper, but this app currently uses the default page pricing.",
    },
    {
        "pricingId": "replicate.kling-o1",
        "label": "Replicate Kling O1",
        "provider": "Replicate",
        "appModelId": "kling-o1",
        "providerModel": "kwaivgi/kling-o1",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_std": 0.084,
            "output_per_second_usd_with_video_input": 0.126,
        },
        "assumptions": "Replicate publishes separate standard and video-input rates; Source Video uses the video-input path.",
        "sourceUrl": "https://replicate.com/kwaivgi/kling-o1",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Use the video-input rate when estimating source-video edit cost.",
    },
    {
        "pricingId": "replicate.kling-v3-omni-video",
        "label": "Replicate Kling v3 Omni Video",
        "provider": "Replicate",
        "appModelId": "kling-v3-omni-video",
        "providerModel": "kwaivgi/kling-v3-omni-video",
        "category": "video_generation",
        "billingUnit": "provider_example",
        "rates": {},
        "assumptions": "Replicate publicly states this model is priced per second of output video, but the visible public page does not expose a simple flat 1080p rate.",
        "sourceUrl": "https://replicate.com/kwaivgi/kling-v3-omni-video",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Keep this entry so admins can fill in an internal effective rate later if needed.",
    },
    {
        "pricingId": "replicate.kling-v3-motion-control",
        "label": "Replicate Kling v3 Motion Control",
        "provider": "Replicate",
        "appModelId": "kling_v3_motion_control",
        "providerModel": "kwaivgi/kling-v3-motion-control",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_std": 0.07,
        },
        "assumptions": "Public Replicate snippet for the official model page lists the standard per-second rate.",
        "sourceUrl": "https://replicate.com/kwaivgi/kling-v3-motion-control",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Used in Character Animate pose-video mode.",
    },
    {
        "pricingId": "replicate.wan-2.7-videoedit",
        "label": "Replicate Wan 2.7 VideoEdit",
        "provider": "Replicate",
        "appModelId": "wan2.7-videoedit",
        "providerModel": "wan-video/wan-2.7-videoedit",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd": 0.1,
        },
        "assumptions": "Replicate publishes a single output-video per-second rate on the model README.",
        "sourceUrl": "https://replicate.com/wan-video/wan-2.7-videoedit/readme",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Public price is not broken out separately by 720p vs 1080p.",
    },
    {
        "pricingId": "replicate.wan-2.7-i2v",
        "label": "Replicate Wan 2.7 image-to-video",
        "provider": "Replicate",
        "appModelId": "wan2.7-i2v",
        "providerModel": "wan-video/wan-2.7-i2v",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_720p": 0.1,
        },
        "assumptions": "Public Replicate model page snippet confirms 720p pricing; no clean public 1080p rate was visible.",
        "sourceUrl": "https://replicate.com/wan-video/wan-2.7-i2v",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Keep this entry editable because 1080p may need to be set manually once Replicate exposes a stable public rate.",
    },
    {
        "pricingId": "replicate.ltx-2.3-pro",
        "label": "Replicate LTX 2.3 Pro",
        "provider": "Replicate",
        "appModelId": "ltx-2.3-pro",
        "providerModel": "lightricks/ltx-2.3-pro",
        "category": "video_generation",
        "billingUnit": "per_second",
        "rates": {
            "output_per_second_usd_1080p": 0.08,
            "output_per_second_usd_2k": 0.16,
        },
        "assumptions": "Replicate publishes explicit 1080p and 2K per-second pricing on the model page.",
        "sourceUrl": "https://replicate.com/lightricks/ltx-2.3-pro",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Use the 1080p rate for standard app estimates.",
    },
    {
        "pricingId": "runware.kling-video-2.6-pro",
        "label": "Runware Kling Video 2.6 Pro",
        "provider": "Runware",
        "appModelId": "kling-2.6",
        "providerModel": "klingai:kling-video@2.6-pro",
        "category": "video_generation",
        "billingUnit": "provider_example",
        "rates": {
            "example_run_cost_usd": 1.4,
            "example_run_duration_seconds": 10.0,
            "effective_example_per_second_usd": 0.14,
        },
        "assumptions": "Runware model page exposes example run costs rather than a formal pricing table.",
        "sourceUrl": "https://runware.ai/models/klingai-video-2-6-pro",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Effective per-second value is derived from the 10-second example shown on the public model page.",
    },
    {
        "pricingId": "runware.veo-3.1",
        "label": "Runware Veo 3.1",
        "provider": "Runware",
        "appModelId": "veo-3.1",
        "providerModel": "google:3@2",
        "category": "video_generation",
        "billingUnit": "provider_example",
        "rates": {
            "example_run_cost_usd": 3.2,
            "example_run_duration_seconds": 4.0,
            "effective_example_per_second_usd": 0.8,
        },
        "assumptions": "Runware public page shows example request cost; effective per-second rate is derived from the default 4-second example shown on the page.",
        "sourceUrl": "https://runware.ai/models/google-veo-3-1",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Treat as an example-derived rate, not a guaranteed fixed price.",
    },
    {
        "pricingId": "runware.veo-3.1-fast",
        "label": "Runware Veo 3.1 Fast",
        "provider": "Runware",
        "appModelId": "veo-3.1-fast",
        "providerModel": "google:3@3",
        "category": "video_generation",
        "billingUnit": "provider_example",
        "rates": {
            "example_run_cost_usd": 1.2,
            "example_run_duration_seconds": 4.0,
            "effective_example_per_second_usd": 0.3,
        },
        "assumptions": "Runware public page shows example request cost; effective per-second rate is derived from the default 4-second example shown on the page.",
        "sourceUrl": "https://runware.ai/models/google-veo-3-1-fast",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Treat as an example-derived rate, not a guaranteed fixed price.",
    },
    {
        "pricingId": "runware.wan2.2-a14b",
        "label": "Runware Wan2.2 A14B",
        "provider": "Runware",
        "appModelId": "wan2.2-a14b",
        "providerModel": "runware:200@6",
        "category": "video_generation",
        "billingUnit": "provider_example",
        "rates": {
            "example_run_cost_usd_low": 0.3507,
            "example_run_cost_usd_high": 0.7328,
        },
        "assumptions": "Runware public page exposes example costs only, and the model does not offer 1080p on the public page.",
        "sourceUrl": "https://runware.ai/models/alibaba-wan2-2-a14b",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Available public resolutions are 480p, 580p, and 720p only.",
    },
    {
        "pricingId": "runware.wan2.2-animate",
        "label": "Runware Wan2.2 Animate",
        "provider": "Runware",
        "appModelId": "wan2.2-animate",
        "providerModel": "",
        "category": "video_generation",
        "billingUnit": "provider_example",
        "rates": {},
        "assumptions": "Current public Runware pages did not expose a stable standalone pricing page for this exact app surface.",
        "sourceUrl": "https://runware.ai/models",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Keep editable so an internal effective rate can be set once the exact upstream public model page is confirmed.",
    },
    {
        "pricingId": "runware.flux-fill-dev",
        "label": "Runware FLUX.1 Fill [dev]",
        "provider": "Runware",
        "appModelId": "runware_flux_fill",
        "providerModel": "runware:102@1",
        "category": "image_generation",
        "billingUnit": "per_image",
        "rates": {
            "per_image_usd_512_square": 0.0019,
            "per_image_usd_1024_square": 0.0038,
        },
        "assumptions": "Runware docs publish image cost by resolution for the underlying FLUX fill model.",
        "sourceUrl": "https://runware.ai/docs/models/bfl-flux-1-dev",
        "sourceCheckedAt": "2026-06-20",
        "notes": "Patch editing in this app usually operates around the 1024-square reference pricing point.",
    },
    {
        "pricingId": "runware.aceplusplus",
        "label": "Runware ACE++ patch editing",
        "provider": "Runware",
        "appModelId": "runware_ace_pp",
        "providerModel": "runware:102@1",
        "category": "image_generation",
        "billingUnit": "per_image",
        "rates": {
            "per_image_usd_1024_square": 0.0038,
        },
        "assumptions": "ACE++ rides the same Runware base model id used for FLUX fill in the current implementation.",
        "sourceUrl": "https://runware.ai/docs/models/bfl-flux-1-dev",
        "sourceCheckedAt": "2026-06-20",
        "notes": "This is a proxy rate until Runware exposes ACE++ pricing separately.",
    },
]


def default_pricing_admin_config() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "entries": deepcopy(_DEFAULT_PRICING_ENTRIES),
        "updatedAt": None,
        "updatedBy": None,
    }


def _normalize_rates(value: Any, *, strict: bool) -> dict[str, Any]:
    if not isinstance(value, dict):
        if strict:
            raise ValueError("rates must be an object")
        return {}
    normalized: dict[str, Any] = {}
    for raw_key, raw_value in value.items():
        key = str(raw_key or "").strip()
        if not key:
            if strict:
                raise ValueError("rates keys must be non-empty strings")
            continue
        if raw_value is None:
            normalized[key] = None
            continue
        try:
            number = float(raw_value)
        except (TypeError, ValueError):
            if strict:
                raise ValueError(f"Rate '{key}' must be numeric or null")
            continue
        if not math.isfinite(number):
            if strict:
                raise ValueError(f"Rate '{key}' must be finite")
            continue
        normalized[key] = number
    return normalized


def _normalize_entry(item: Any, *, strict: bool) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        if strict:
            raise ValueError("Each pricing entry must be an object")
        return None
    pricing_id = str(item.get("pricingId") or "").strip()
    label = str(item.get("label") or "").strip()
    provider = str(item.get("provider") or "").strip()
    billing_unit = str(item.get("billingUnit") or "").strip()
    source_url = str(item.get("sourceUrl") or "").strip()
    source_checked_at = str(item.get("sourceCheckedAt") or "").strip()
    if strict:
        if not pricing_id:
            raise ValueError("pricingId is required for each entry")
        if not label:
            raise ValueError(f"Entry '{pricing_id or '?'}' is missing label")
        if not provider:
            raise ValueError(f"Entry '{pricing_id or '?'}' is missing provider")
        if billing_unit not in _ALLOWED_BILLING_UNITS:
            raise ValueError(
                f"Entry '{pricing_id or '?'}' must use one of: {', '.join(sorted(_ALLOWED_BILLING_UNITS))}"
            )
        if not source_url:
            raise ValueError(f"Entry '{pricing_id or '?'}' is missing sourceUrl")
        if not source_checked_at:
            raise ValueError(f"Entry '{pricing_id or '?'}' is missing sourceCheckedAt")
    if not pricing_id or not label or not provider or not billing_unit:
        return None
    if billing_unit not in _ALLOWED_BILLING_UNITS:
        return None
    return {
        "pricingId": pricing_id,
        "label": label,
        "provider": provider,
        "appModelId": str(item.get("appModelId") or "").strip() or None,
        "providerModel": str(item.get("providerModel") or "").strip() or None,
        "category": str(item.get("category") or "").strip() or None,
        "billingUnit": billing_unit,
        "rates": _normalize_rates(item.get("rates"), strict=strict),
        "assumptions": str(item.get("assumptions") or "").strip() or None,
        "sourceUrl": source_url or None,
        "sourceCheckedAt": source_checked_at or None,
        "notes": str(item.get("notes") or "").strip() or None,
    }


def normalize_pricing_admin_config_for_read(raw: dict[str, Any] | None) -> dict[str, Any]:
    defaults = default_pricing_admin_config()
    if not isinstance(raw, dict):
        return defaults
    raw_entries = raw.get("entries")
    normalized_entries: list[dict[str, Any]] = []
    if isinstance(raw_entries, list):
        for item in raw_entries:
            normalized = _normalize_entry(item, strict=False)
            if normalized is not None:
                normalized_entries.append(normalized)
    if not normalized_entries:
        normalized_entries = deepcopy(defaults["entries"])
    return {
        "schemaVersion": 1,
        "entries": normalized_entries,
        "updatedAt": raw.get("updatedAt"),
        "updatedBy": raw.get("updatedBy"),
    }


def normalize_pricing_admin_config_for_write(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Invalid config payload")
    raw_entries = payload.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise ValueError("entries must be a non-empty array")
    normalized_entries = [_normalize_entry(item, strict=True) for item in raw_entries]
    return {
        "schemaVersion": 1,
        "entries": [entry for entry in normalized_entries if isinstance(entry, dict)],
    }


def find_pricing_entry(
    config: dict[str, Any],
    *,
    pricing_id: str | None = None,
    app_model_id: str | None = None,
    provider_model: str | None = None,
) -> dict[str, Any] | None:
    entries = config.get("entries") if isinstance(config, dict) else None
    if not isinstance(entries, list):
        return None
    normalized_pricing_id = str(pricing_id or "").strip()
    normalized_app_model_id = str(app_model_id or "").strip()
    normalized_provider_model = str(provider_model or "").strip()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if normalized_pricing_id and str(entry.get("pricingId") or "").strip() == normalized_pricing_id:
            return entry
        if normalized_app_model_id and str(entry.get("appModelId") or "").strip() == normalized_app_model_id:
            return entry
        if normalized_provider_model and str(entry.get("providerModel") or "").strip() == normalized_provider_model:
            return entry
    return None


def resolve_openai_token_pricing(config: dict[str, Any], model: str) -> dict[str, float] | None:
    entry = find_pricing_entry(config, pricing_id=f"openai.{model}.responses", app_model_id=model, provider_model=model)
    if not isinstance(entry, dict):
        return None
    rates = entry.get("rates")
    if not isinstance(rates, dict):
        return None
    input_price = rates.get("input_per_1m_tokens_usd")
    output_price = rates.get("output_per_1m_tokens_usd")
    try:
        if input_price is None or output_price is None:
            return None
        return {"input": float(input_price), "output": float(output_price)}
    except (TypeError, ValueError):
        return None
