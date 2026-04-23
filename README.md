# AI-assisted VFX Micro-Pipeline

Production-oriented React + AWS serverless application for frame-accurate VFX experimentation. The app takes a source video, lets a user select frames and segments, edit/refine first frames, generate replacement video segments with multiple AI providers, QC the results, and merge the selected result back into the source timeline.

## Repository Layout

- `frontend/`: React, TypeScript, Vite, Tailwind, TanStack Query, Zustand
- `backend/`: Python 3.10 Lambda API and SQS worker code
- `infra/`: AWS CDK stack for S3, CloudFront, Cognito, HTTP API Gateway, Lambda, SQS, IAM, and Secrets Manager
- `api-readme.md`: developer-facing external API documentation
- `README-charactertool.md`: notes for the current Wan Animate support and future character-animation workflow

## Current Application Flow

The main workflow is task-based. Assets and task metadata are private to the authenticated Cognito user.

1. **Upload / Ingest**
   - Upload a source video.
   - The backend probes media with `ffprobe`, creates or records a constant-frame-rate edit source, generates a lightweight preview proxy, and creates timeline thumbnails.
   - The app supports longer source uploads for selection, but model-specific generation requests still enforce provider duration and frame-budget limits later in the flow.

2. **Select Frames**
   - Previously named Pick Frames.
   - The user creates frame captures and frame-accurate video segments from the source timeline.
   - Segment creation supports the current general 10-second application limit, with later model-specific validation when a model has a stricter hard limit.

3. **Edit Frames**
   - Previously named Edit Frame.
   - The user edits selected frames with full-frame or patch-based image models.
   - Supported frame-edit providers include Gemini Nano Banana / Nano Banana Pro, ChatGPT image generation, Runware Flux Fill, and Runware ACE++.
   - The QA launch button was removed from Edit Frames thumbnail blocks; Quality Match is now launched from the Refine Frames step.

4. **Refine Frames**
   - Runs Quality Match analysis and mask refinement between the original frame and edited frame.
   - Produces diff maps, edge/change masks, restoration previews, and final refined frame variants.
   - Supports SAM 2 assist through fal.ai, brush/lasso mask editing, and optional OpenCV seamless-clone compositing from Keep Mask Actions.
   - The keep-mask convention is: white/kept areas preserve the edited frame; outside the mask is restored from the original frame.

5. **Generate Video**
   - Generates replacement video for a selected segment using the refined first frame and, where supported, a video guidance segment.
   - Multiple overlapping generation jobs are supported. Jobs are logged independently and completed results are added to the grid without overwriting earlier outputs.
   - The comparator is separated from background polling so selected generated previews do not flicker or resize during job refreshes.

6. **Video Cleanup / Refine**
   - Available from successful Luma-generated video thumbnails.
   - Tracks the first-frame keep mask through the generated video using SAM 2 and lets users preview, edit, retrack, tune, and apply a cleaned segment.
   - The cleanup composite restores original source pixels outside the tracked keep mask.

7. **Merge / Export**
   - Inserts the selected generated segment back into the edit-source timeline.
   - Uses stored timing metadata and estimated source-frame offsets where available.
   - Supports trims, start-frame override, temporal feathering, and generated crop compositing.

8. **Reports**
   - Quality reports compare original, edited, refined, and generated assets.
   - Custom QC supports two uploaded images or two uploaded videos; video uploads are sampled from the first frame and then every two seconds.
   - Video comparison reports compare selected generations from the same segment/start frame with aligned frame grids, diff grids, zoomed crops, model settings, input/output resolution, fps, duration, and frame counts.

9. **API Playground / API Logs**
   - The standalone API playground is served at `/experiments/aivfx/api-test.html`.
   - A task-nav link opens the API logs page, showing external API jobs with input/output asset previews and errors.

## Supported Generation Models

The app routes models through provider-specific adapters and normalizes inputs/outputs where needed.

| Model | Provider | Main input mode | Notes |
| --- | --- | --- | --- |
| Luma Ray 2 | Luma | first frame + video segment | Supports Luma modify modes; Luma outputs can use Video Cleanup |
| Luma Ray 2 Flash | Luma | first frame + video segment | Faster Luma route; provider may return lower resolution than source |
| Runway Gen-4.5 | Runway | image-to-video | First-frame guided |
| Kling 2.6 | Runware/Kling | start image, optional end image | Provider duration constraints are enforced |
| Kling O1 Edit | Replicate | video + reference image in prompt | Prompt must reference `<<<video_1>>>` and `<<<image_1>>>`; `video_reference_type=base`; original sound kept |
| Kling v3 Omni Video | Replicate | video + reference image in prompt | Similar prompt guidance to Kling O1 |
| Seedance 2.0 Reference-to-Video | fal.ai | video + reference image in prompt | Prompt must reference `@Video1` and `@Image1`; content-policy moderation cannot be disabled |
| Veo 3.1 / Veo 3.1 Fast | fal.ai | start image, optional end image | Provider-specific duration and frame-budget checks |
| Wan2.2 A14B | Runware | image-to-video | Provider dimensions are conformed to supported sizes |
| Wan2.2 Animate | Runware | reference image + reference video | Prompt omitted unless LoRA support is added; strict supported dimensions |
| Wan2.7 VideoEdit | Replicate | video + reference image | Resolution selectable as 720p or 1080p; reference image is provided in the required provider shape |

## Duration, FPS, and Resolution Handling

The application keeps the source timeline as the authority.

- Ingest records source `fps`, `frameCount`, `durationSec`, width, height, and VFR/CFR state.
- VFR source material is converted to a CFR edit source for frame-accurate downstream processing.
- Provider input videos may be resized or re-encoded to meet model-specific constraints.
- Model hard limits are validated at generation time and shown only when relevant to the selected model and segment.
- Provider outputs are downloaded into private S3, probed, and then conformed where needed to the source segment fps/resolution for merge continuity.
- The worker stores both raw provider-output metadata and stored/conformed-output metadata.
- Source-frame offset estimation is stored on generated segments and used by default in the merge controls.

This means the app can preserve timeline duration and merge alignment even when providers drop frames, change fps, or return a different resolution.

## Backend Execution Model

The backend is split into a synchronous API Lambda and an async SQS worker.

- `backend/src/api_handler.py`
  - Validates HTTP requests with Pydantic.
  - Reads/writes task and API request metadata in S3 JSON records.
  - Issues private S3 presigned URLs.
  - Creates job records and queues long-running work.

- `backend/src/worker_handler.py` and `backend/src/workers/processor.py`
  - Runs ingest, frame edits, Quality Match, SAM assist, video generation, Video Cleanup, reports, merge/export, and external API requests.
  - Ignores duplicate SQS deliveries for already-complete jobs.
  - Handles concurrent jobs without relying on a single UI refresh race.

The main persisted records are:

- `TaskDetail`: task snapshot containing video metadata, segments, frames, frame variants, segment generations, cleanup tracks, reports, and exports.
- `JobStatus`: async job state with `type`, `status`, `progress`, `logs`, `error`, and `resultRefs`.
- `ExternalApiRequest`: standalone API request record under the authenticated user.

Storage is currently S3 JSON based. DynamoDB remains a future migration candidate once the data model settles.

## Async Job Types

Current worker job types include:

- `ingest_video`
- `edit_full`
- `edit_patch`
- `quality_match_apply`
- `quality_match_sam`
- `segment_generate`
- `merge_export`
- `qc_analysis`
- `qc_report_build`
- `motion_sync_qc`
- `video_cleanup_init`
- `video_cleanup_track`
- `video_cleanup_retrack_window`
- `video_cleanup_preview`
- `video_cleanup_apply`
- `api_image_edit_full`
- `api_image_edit_patch`
- `api_video_generation_reference`

## Key Server-Side Functions

### ffmpeg and ffprobe

The ffmpeg wrapper lives in `backend/src/core/ffmpeg.py`. Functions operate on local files and are used by both task workflows and external API workflows.

| Function | Primary use | Inputs | Outputs |
| --- | --- | --- | --- |
| `ffprobe_video(input_path)` | Inspect uploaded/generated video | local video path | width, height, fps, duration, frame count, codec, audio, VFR/CFR fields |
| `transcode_to_cfr(input_path, output_path, fps, ...)` | Normalize VFR or provider output | input/output paths, target fps, optional size | CFR MP4 |
| `transcode_for_preview(input_path, output_path, ...)` | Ingest preview proxy | source path, fps, source geometry | preview MP4 and dimensions |
| `transcode_for_provider(input_path, output_path, ...)` | Provider-safe input video | source path, geometry, target bounds | MP4 and prepared dimensions |
| `extract_frame_png(input_path, frame_index, output_path, ...)` | Frame capture, thumbnails, report frames | 0-based frame index, optional crop/scale | PNG file |
| `extract_segment_by_frames(input_path, output_path, start_frame, end_frame_exclusive, fps_num, fps_den, ...)` | Segment preparation | frame bounds and source fps | MP4 segment |
| `generate_thumbnail_strip(input_path, output_dir, ...)` | Timeline thumbnails | video path, output directory | JPEG strip and manifest data |
| `compose_cropped_generated_segment(...)` | Composite generated crop back into full frame | edit source, generated segment, crop/feather/trim | MP4 plus ffmpeg command |
| `merge_with_segment_replacement(...)` | Final merge/export | edit source, generated segment, frame bounds, trims, feather | MP4 plus ffmpeg command |

Important behavior:

- The edit source timeline is the canonical timeline.
- Provider outputs are never assumed to have the requested fps/resolution; they are probed and normalized.
- Merge/export preserves duration and can preserve audio from the edit source.

### Quality Match, Diff, Edge, and Keep Masks

Quality Match code lives mainly in:

- `backend/src/quality_match/service.py`
- `backend/src/quality_match/apply_flow.py`
- `backend/src/quality_match/sam_assist.py`

Core functions:

- `analyse_quality_match(...)`
  - Inputs: original frame bytes, generated frame bytes, settings, optional source mask, optional user override mask.
  - Outputs: metrics, warnings, aligned generated image, diff heatmap, binary change mask, proposed merge mask, restoration map, preview image, and report JSON.

- `preview_quality_match_from_mask(...)`
  - Inputs: original bytes, generated/aligned generated bytes, final user mask, settings.
  - Outputs: preview composite, final mask, preview metrics, warnings, report.
  - Does not create a new frame variant.

- `apply_quality_match(...)` and `apply_quality_match_to_task(...)`
  - Inputs: original/generated bytes, final mask bytes, settings, task/frame/analysis context.
  - Outputs: final merged PNG, persisted final mask, report JSON, metrics, and a new refined frame variant.

- `request_sam2_proposals(...)`
  - Inputs: image bytes, positive/negative points, optional box, optional existing mask, restriction settings.
  - Outputs: SAM proposal masks with scores and bounds, persisted as private S3 assets.

Diff/Edge terminology:

- Diff Map is a colorized absolute-difference heatmap.
- Edge Map is a cleaned thresholded binary change mask.
- Quality Match uses diff/edge analysis for suggested masks and diagnostics. The final keep-mask compositing is driven by the user-selected mask.

Optional seamless clone:

- OpenCV seamless clone is exposed as a user-visible Keep Mask Action setting.
- It is no longer silently forced as the only high-seam-risk behavior.

### Video Cleanup

Video Cleanup code lives in `backend/src/video_cleanup/` and frontend components under `frontend/src/components/cleanup/`.

Purpose:

- Track a first-frame keep mask through a generated Luma video using SAM 2.
- Let the user review overlay/check frames, edit masks, retrack windows, tune cleanup settings, and apply a cleaned segment.

Core idea:

```text
output = generated * keep_mask + original * (1 - keep_mask)
```

Settings include:

- mask feather / hardness
- restore strength outside the keep mask
- mask dilate / erode
- temporal smoothing
- tracking density for high-motion clips

Artifacts are stored under:

```text
users/{userId}/tasks/{taskId}/cleanup_tracks/{trackId}/...
```

## HTTP API Summary

The task API is Cognito-authenticated except `GET /health`. Long-running routes return `jobId`; the frontend polls `GET /jobs/{jobId}`.

Key task routes:

- `GET /health`
- `GET /me`
- `POST /tasks`
- `GET /tasks`
- `GET /tasks/{taskId}`
- `DELETE /tasks/{taskId}`
- `POST /tasks/{taskId}/uploads/video`
- `POST /tasks/{taskId}/ingest`
- `GET /tasks/{taskId}/thumbnails`
- `GET /tasks/{taskId}/frames/strip`
- `POST /tasks/{taskId}/segments`
- `PATCH /tasks/{taskId}/segments/{segmentId}`
- `POST /tasks/{taskId}/frames`
- `POST /tasks/{taskId}/frames/{frameId}/edit/full`
- `POST /tasks/{taskId}/frames/{frameId}/edit/patch`
- `POST /tasks/{taskId}/frames/{frameId}/quality-match/analyse`
- `POST /tasks/{taskId}/frames/{frameId}/quality-match/apply`
- `POST /tasks/{taskId}/frames/{frameId}/quality-match/sam`
- `POST /tasks/{taskId}/segments/{segmentId}/generate`
- `POST /tasks/{taskId}/exports/merge`
- `POST /tasks/{taskId}/reports/...`
- `POST /tasks/{taskId}/segments/{segmentId}/generations/{generationId}/cleanup-tracks`
- `GET /tasks/{taskId}/cleanup-tracks/{trackId}`
- `POST /tasks/{taskId}/cleanup-tracks/{trackId}/keyframes/upload-init`
- `POST /tasks/{taskId}/cleanup-tracks/{trackId}/keyframes/complete`
- `POST /tasks/{taskId}/cleanup-tracks/{trackId}/sam-assist`
- `POST /tasks/{taskId}/cleanup-tracks/{trackId}/preview`
- `POST /tasks/{taskId}/cleanup-tracks/{trackId}/apply`
- `GET /jobs/{jobId}`

Developer-facing external API routes are documented in `api-readme.md`.

## External API

The external API reuses the same backend modules as the app but stores assets outside task folders:

- Uploads: `users/{userId}/api_uploads/...`
- Request assets: `users/{userId}/api_requests/{requestId}/...`
- Request metadata: `users/{userId}/api_requests/{requestId}.json`

Current external API workflows:

- full image edit
- patch image edit
- first-frame + video reference generation

The API is async, Cognito user-delegated, and request scoped. Each API request gets its own record and asset namespace to avoid collisions when multiple generations run concurrently.

See `api-readme.md` for request schemas, model options, validation, and auth guidance.

## Reports

Implemented report surfaces:

- Frame Quality Match reports with model, timing, mask, diff, edge, preview, and final metrics.
- Custom QC reports for uploaded image pairs or video pairs.
- Video comparison reports for selected generated videos from the same segment/start frame.
- Motion/alignment-aware frame comparisons that attempt to compare corresponding source frames rather than naive output frame numbers.

Report running states are visually emphasized so first-run report generation is clear to users.

## Infrastructure

The CDK stack provisions:

- private asset S3 bucket
- CloudFront distribution for the static frontend
- Cognito user pool and app client
- HTTP API Gateway
- Lambda API function
- Lambda SQS worker function
- SQS queue with DLQ and extended visibility timeout
- IAM policies for S3, SQS, Secrets Manager, and logging

Provider credentials are read from Secrets Manager/environment, not committed to the repo.

## Local Development

Install dependencies:

```bash
cd frontend && npm install
cd ../infra && npm install
```

Build frontend:

```bash
cd frontend
npm run build
```

Build infra TypeScript:

```bash
cd infra
npm run build
```

Python syntax check:

```bash
python3 -m py_compile backend/src/api_handler.py backend/src/workers/processor.py
```

Deploy is handled through the existing CDK/static-site workflow used for the live application.
