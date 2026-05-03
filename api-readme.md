# AIVFX External API Readme

This document describes the developer-facing API that sits alongside the main AIVFX UI.

The API calls the same editing and generation modules used by the application. It does not expose raw provider payloads directly. Incoming media is validated, normalized where needed, saved in user-scoped S3 folders, and then passed to the same provider adapters as the app.

The application UI is now organized around:

- `Select`
- `Edit`
- `Generate`
- `Post Process`
- `Reports`

The external API is intentionally more operation-oriented than wizard-oriented, but it shares the same model capability registry, media preparation, provider routing, and output normalization.

## Quick Start

1. Sign in with Cognito and obtain an ID token.
2. Create presigned upload URLs with `POST /api/v1/assets/uploads/init`.
3. Upload image/video/mask bytes directly to S3 using the returned URL.
4. Start an async workflow request.
5. Poll `GET /api/v1/requests/{requestId}` or `GET /jobs/{jobId}`.
6. Read presigned output URLs from the completed request.

A browser playground is available at:

```text
/experiments/aivfx/api-test.html
```

It supports Cognito sign-in, image/video/mask uploads, prompt input, request submission, live logs, API schema preview, and output preview/download.

## Authentication

All external API routes require a Cognito-authenticated bearer token.

```http
Authorization: Bearer <cognito-id-token>
```

Current security model:

- User-delegated Cognito auth is used.
- The Cognito `sub` owns API assets and request records.
- Assets are private and exposed only through short-lived presigned URLs.

Current limitation:

- Machine-to-machine client credentials are not implemented yet.
- Do not put provider API keys or Cognito secrets in browser code.
- Browser clients may use the public Cognito app client ID and hosted UI configuration only.

Recommended future addition:

- Add a separate Cognito resource server, external API scopes, and a client-to-tenant ownership mapping before supporting non-user M2M tokens.

## Storage Model

External API storage is intentionally separate from task storage.

```text
users/{userId}/api_uploads/{assetId}/...
users/{userId}/api_requests/{requestId}/...
users/{userId}/api_requests/{requestId}.json
users/{userId}/jobs/{jobId}.json
```

This avoids coupling external API calls to task lifecycle state and prevents one API request from overwriting another request’s assets.

## Async and Concurrency Behavior

Every generation/edit request creates:

- an API request record
- an async job record
- request-scoped prepared inputs and outputs

The backend saves the API request before enqueueing the worker job. This avoids the race where a worker starts before the request metadata exists. The worker also ignores duplicate SQS deliveries for already-complete jobs.

Concurrent requests are expected. Multiple jobs for the same user, model, or input asset should complete independently.

## Shared Pipeline Behavior

The API and the main app share the same backend model capability registry and media-prep rules.

That means API requests inherit the same behavior for:

- model and mode validation
- prompt marker validation
- duration and frame-budget checks
- FPS caps and preserve-frames behavior where supported
- provider-specific video/reference-image preparation
- output timeline conform back into the stored media format

The core implementation lives in:

- `backend/src/generation/capabilities.py`
- `backend/src/api_handler.py`
- `backend/src/workers/processor.py`

## Endpoint Summary

| Method + path | Purpose |
| --- | --- |
| `POST /api/v1/assets/uploads/init` | Create a presigned S3 upload URL |
| `POST /api/v1/image-edits/full` | Full-frame image edit |
| `POST /api/v1/image-edits/patch` | Patch/mask-based image edit |
| `POST /api/v1/video-generations/reference-video` | First-frame + video reference generation |
| `GET /api/v1/requests` | List API request records |
| `GET /api/v1/requests/{requestId}` | Get one API request with presigned asset URLs |
| `GET /jobs/{jobId}` | Get raw async job status |

## Upload Assets

```http
POST /api/v1/assets/uploads/init
```

Request:

```json
{
  "filename": "source.png",
  "contentType": "image/png",
  "assetType": "image"
}
```

Response:

```json
{
  "assetId": "apiasset_123",
  "assetKey": "users/.../api_uploads/apiasset_123/incoming.png",
  "uploadUrl": "https://..."
}
```

Validation:

- `assetType=image` requires `image/*`.
- `assetType=video` requires `video/*`.
- `assetType=mask` is treated as image-like and requires an image content type.
- Uploaded asset keys must belong to the authenticated user’s `api_uploads` namespace.

## Full Image Edit

```http
POST /api/v1/image-edits/full
```

Request:

```json
{
  "model": "chatgpt",
  "prompt": "Turn the car into a worn military jeep",
  "inputAssetKey": "users/.../api_uploads/apiasset_123/incoming.png"
}
```

Response:

```json
{
  "requestId": "apireq_123",
  "jobId": "job_123"
}
```

Supported models:

- `chatgpt`
- `chatgpt_latest`
- `nano_banana`
- `nano_banana_pro`

Output:

- edited image saved under `api_requests/{requestId}/outputs/`
- output width/height metadata where available
- logs from worker/provider handling

## Patch Image Edit

```http
POST /api/v1/image-edits/patch
```

Request:

```json
{
  "model": "runware_ace_pp",
  "prompt": "Replace the horse head with a white unicorn head",
  "inputAssetKey": "users/.../api_uploads/source/incoming.png",
  "patchAssetKey": "users/.../api_uploads/patch/incoming.png",
  "maskAssetKey": "users/.../api_uploads/mask/incoming.png",
  "referenceAssetKey": "users/.../api_uploads/ref/incoming.png",
  "patchRect": { "x": 320, "y": 120, "width": 640, "height": 640 },
  "featherPx": 24,
  "bleedPx": 32,
  "runwareRepaintingScale": 0.7,
  "edgeAwareRefine": true,
  "edgeAwareStrength": 0.45,
  "edgeAwareRadiusPx": 6,
  "maskGrowPx": 0
}
```

Supported models:

- `chatgpt`
- `chatgpt_latest`
- `nano_banana_pro`
- `runware_flux_fill`
- `runware_ace_pp`

Validation:

- `runware_ace_pp` requires `referenceAssetKey`.
- `patchRect` must be within the source image.
- mask, patch, reference, and source asset keys must belong to the authenticated user.

Processing:

- Patch and mask inputs may be expanded by bleed.
- Masks may be feathered and optionally edge-refined.
- Output is composited back into the original image geometry.

This matches the same patch-edit and contextual refine conventions used in the app’s `Edit frames` and `Refine Frames` tools.

## Reference Video Generation

```http
POST /api/v1/video-generations/reference-video
```

Request:

```json
{
  "model": "kling-o1",
  "mode": "kling_o1_video_edit",
  "prompt": "Transform the horse in <<<video_1>>> into the unicorn in <<<image_1>>>. Keep motions, camera movement and background the same.",
  "videoAssetKey": "users/.../api_uploads/video/incoming.mp4",
  "firstFrameAssetKey": "users/.../api_uploads/first/incoming.png",
  "replicateKlingMode": "pro"
}
```

Supported models:

- `ray-2`
- `ray-flash-2`
- `runway-gen4.5`
- `runway-gen4-aleph`
- `kling-2.6`
- `kling-o1`
- `kling-v3-omni-video`
- `seedance-2.0-reference-to-video`
- `veo-3.1`
- `veo-3.1-fast`
- `wan2.2-a14b`
- `wan2.2-animate`
- `wan2.7-videoedit`

Mode compatibility:

| Model | Valid mode |
| --- | --- |
| `ray-2`, `ray-flash-2` | Luma modes such as `adhere_*`, `flex_*`, `reimagine_*` |
| `runway-gen4.5` | `runway_i2v` |
| `runway-gen4-aleph` | `runway_aleph_v2v` |
| `kling-2.6` | `kling_start_only`, `kling_start_end` |
| `veo-3.1`, `veo-3.1-fast` | `veo_start_only`, `veo_start_end` |
| `wan2.2-a14b` | `wan_a14b_i2v` |
| `wan2.2-animate` | `wan_animate_replace` |
| `kling-o1` | `kling_o1_video_edit` |
| `kling-v3-omni-video` | `kling_v3_omni_video_edit` |
| `seedance-2.0-reference-to-video` | `seedance_reference_to_video` |
| `wan2.7-videoedit` | `wan27_video_edit` |

Provider-specific validation:

- Seedance prompts must include `@Video1` and `@Image1`.
- Seedance content-policy moderation is enforced by the provider and cannot be disabled.
- Runway Gen-4 Aleph uses the source video plus the uploaded first-frame image as a reference and requires one of Runway's supported output ratios. The app selects the nearest supported ratio and Runway may center-crop inputs to fit it.
- The app currently applies a conservative 10-second limit to Runway Gen-4 Aleph within this pipeline.
- Kling O1 and Kling v3 prompts should include `<<<video_1>>>` and `<<<image_1>>>`.
- Wan2.7 VideoEdit supports 720p or 1080p selection.
- Some models enforce duration by seconds; others effectively enforce a frame budget at a fixed fps.

Duration behavior:

- The application-wide segment limit is currently 10 seconds.
- API video generation validates model-specific limits before provider submission.
- Seedance supports a longer provider duration than several other routes, but may return shorter outputs for some prompts/media.
- The worker records source duration, prepared-input timing, raw provider-output timing, and stored-output timing.

FPS and resolution behavior:

- Input video is probed before provider submission.
- Provider-prepared video may be resized/re-encoded to satisfy model constraints.
- For relevant models, the pipeline can preserve source-frame count by retiming the prepared provider input instead of dropping/resampling frames.
- Raw provider output is saved and probed.
- If the provider output fps/resolution differs from the source timeline, a conformed stored output is generated for merge continuity.
- Metadata records both raw and conformed output.

Typical completed output fields:

```json
{
  "status": "complete",
  "outputAssets": {
    "output": {
      "key": "users/.../api_requests/apireq_123/outputs/output.mp4",
      "url": "https://...",
      "width": 1920,
      "height": 1080,
      "fps": 24,
      "durationSec": 8.0
    }
  },
  "normalization": {
    "source": { "width": 1920, "height": 1080, "fps": 25, "durationSec": 8.0 },
    "providerInput": { "width": 1112, "height": 834, "fps": 25 },
    "providerOutputRaw": { "width": 1280, "height": 720, "fps": 24, "durationSec": 4.0 },
    "storedOutput": { "width": 1920, "height": 1080, "fps": 25, "durationSec": 8.0 },
    "timelineConform": { "applied": true }
  }
}
```

## Request Logs

```http
GET /api/v1/requests
GET /api/v1/requests?status=failed
GET /api/v1/requests?workflow=video_generation_reference&limit=20
GET /api/v1/requests/{requestId}
```

Request records include:

- workflow name
- status
- model and prompt hash/context
- created/updated timestamps
- input/prepared/output assets with presigned URLs
- logs
- error details
- linked `jobId`

The API logs page in the app exposes the same information for debugging.

## Job Polling

```http
GET /jobs/{jobId}
```

Job statuses:

- `queued`
- `running`
- `complete`
- `failed`

Jobs include progress percentage, text logs, error messages, and `resultRefs`.

## Error Format

Validation errors are returned with clear messages where possible.

Example:

```json
{
  "message": "Seedance prompts must reference @Video1 and @Image1"
}
```

Provider errors are wrapped and stored on the request/job:

```json
{
  "status": "failed",
  "error": "fal.ai API error (422): content_policy_violation",
  "logs": [
    { "level": "request", "message": "Loading video generation assets" },
    { "level": "error", "message": "The images or videos provided may contain likenesses of real people..." }
  ]
}
```

Common failure classes:

- invalid or cross-user asset key
- unsupported content type
- prompt missing provider-required placeholders
- video too long for selected model
- provider content policy block
- provider returned no image/video output
- provider timeout or async prediction failure

## Developer Notes

- Use the API playground for smoke testing auth, uploads, payload shape, and logs.
- Do not commit tokens, Cognito secrets, or provider keys.
- Keep request IDs as the primary unit of API idempotency/debugging.
- Treat S3 presigned URLs as short-lived and do not persist them client-side as durable references.
- Use `GET /api/v1/requests/{requestId}` to refresh URLs when needed.
