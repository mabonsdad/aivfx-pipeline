# AI-assisted VFX Micro-Pipeline

Production-oriented React + AWS serverless application for frame-accurate VFX experimentation. The app takes a source video, lets a user define a reusable working range, edit/refine key frames, generate alternative outputs with multiple AI providers, QC the results, and merge the selected result back into the source timeline.

## Repository Layout

- `frontend/`: React, TypeScript, Vite, Tailwind, TanStack Query, Zustand
- `backend/`: Python 3.10 Lambda API and SQS worker code
- `infra/`: AWS CDK stack for S3, CloudFront, Cognito, HTTP API Gateway, Lambda, SQS, IAM, and Secrets Manager
- `docs/external-api-reference.md`: developer-facing external API documentation
- `README-charactertool.md`: notes for the current Wan Animate support and future character-animation workflow

## AWS CLI Region

The AIVFX stack lives in `eu-west-2`. Set your CLI default there unless you have a profile-specific reason not to:

```bash
aws configure set region eu-west-2
```

If you use a named profile:

```bash
aws configure set region eu-west-2 --profile YOUR_PROFILE
```

Check the active value with:

```bash
aws configure get region
```

The deploy helpers in this repo also force `eu-west-2` if no region is set, which avoids accidentally deploying AIVFX infra into the wrong region.

## Common Deploy Commands

Use these from the repo root:

```bash
npm run deploy:infra:shared
npm run deploy:infra:prod
npm run deploy:infra:dev
npm run deploy:frontend:prod
npm run deploy:frontend:dev
```

`deploy:infra:shared` updates the long-lived shared stack that currently backs the path-hosted dev app and its historical data.

`deploy:infra:prod` updates the isolated production stack in `eu-west-2`.

`deploy:infra:dev` creates or updates the separate development backend/auth/storage stack in `eu-west-2`.

`deploy:frontend:prod` builds the subdomain frontend from `infra/cdk-outputs.prod.json`, writes `frontend/.env.production.local`, syncs to the prod web bucket, and invalidates the prod CloudFront distribution.

`deploy:frontend:dev` builds the path-hosted dev frontend from `infra/cdk-outputs.dev.json`, writes `frontend/.env.devhosted.local`, syncs it to `s3://shwsh.co.uk/experiments/aivfx/`, and invalidates the root-site CloudFront path.

## Current Environment Topology

- Dev frontend: `https://www.shwsh.co.uk/experiments/aivfx/`
- Dev backend/data baseline: shared `AivfxStack`
- Prod frontend: `https://aivfx.shwsh.co.uk/`
- Prod backend/data: isolated `AivfxProdStack`
- Optional isolated dev stack: `AivfxDevStack`

This means prod starts clean and isolated, while the path-hosted dev app keeps the older shared dataset for testing and troubleshooting.

## Clone Prod Tasks Into Dev

For troubleshooting, clone a specific production task into the isolated dev environment instead of mirroring prod continuously:

```bash
python3 scripts/clone_prod_task_to_dev.py --task-id TASK_ID --target-email YOUR_LOGIN_EMAIL
```

You can also target a specific dev Cognito user id directly:

```bash
python3 scripts/clone_prod_task_to_dev.py --task-id TASK_ID --target-user-id COGNITO_SUB
```

Dry-run first if you want a copy count before moving data:

```bash
python3 scripts/clone_prod_task_to_dev.py --task-id TASK_ID --target-email YOUR_LOGIN_EMAIL --dry-run
```

The clone tool:

- copies one prod task at a time into the dev metadata and asset buckets
- copies referenced report JSON and referenced task assets
- stamps the cloned task with `clonedFrom`
- rewrites task-scoped S3 keys into the dev bucket namespace
- marks in-flight prod background states as failed in dev so the cloned task does not wait on non-existent prod jobs

## Current UI Structure

The underlying storage is still task-based, but the UI now presents each task as an uploaded source video. Assets and metadata remain private to the authenticated Cognito user.

1. **Select**
   - Upload and ingest a source video.
   - The backend probes media with `ffprobe`, creates or records a constant-frame-rate edit source, generates a lightweight preview proxy, and creates timeline thumbnails.
   - Users choose the creation route here:
     - source motion (`first frame + video`)
     - animate between two frames (`start + end`)
     - animate from start frame only
   - The app creates a default full-video working range automatically. Users can also define and save shorter custom working ranges.
   - Optional crop is configured here and is later merged back in Post Process.

2. **Edit**
   - The Edit area then exposes only the inputs required for that route.
   - `Edit frames` remains the main still-edit surface.
   - `Refine Frames` is now a contextual workspace opened from edited outputs rather than a primary peer step.
   - Source frames can be downloaded and manually edited frames can be uploaded back into the current frame grid.

3. **Generate**
   - Video generation controls and generated attempts are reviewed here for the current working range.
   - The chosen output is compared against the source and handed forward into Post Process.
   - Video compare modal now uses synchronized auto-loop playback (no native browser control bar) with explicit `Source` and `Generated` labels and non-blocking source-load fallback.
   - Generation previews, compare playback, and output thumbnails now keep stable media URLs across normal step navigation. Signed URLs are refreshed only after real media failures or after returning from a longer idle period.
   - Users can also download the current working-range source clip and manually upload a generated video, which is attached to the current working reference as a normal output.
   - Multiple overlapping generation jobs are supported. Jobs are tracked independently and completed results are added without overwriting earlier outputs.
   - For long-video source-motion runs, chunked/continuation drafts stay inside their session UI until a stitched draft is saved back to Generate.

4. **Post Process**
   - Acts on the currently chosen output from Generate.
   - Supports:
     - extend/continuation for long videos
     - reconcile timing, merge alignment, and export
     - crop merge-back
     - tracked keep-mask cleanup on eligible source-motion outputs
   - Extend continuation chunks are now created as internal child ranges, so they do not replace the user-visible working-range selection.
   - Queueing an extension keeps the user in Post Process (no auto-navigation back to Generate), and continuation outputs are shown newest-first in the Extend grid.
   - Align & Retime now uses a compact `Suggested / Controls` flow with explicit start-shift, trim, and stretch controls.
   - Alignment suggestions do not auto-apply. Users explicitly apply suggestion values before reconcile.
   - Merge previews, zoom tools, alignment suggestion, and optional retime are all part of this stage.

5. **Assets**
   - Shows merged videos, generated videos, and edited frames for the current source video.
   - Report creation now starts here from selected asset grids.
   - A separate Asset Library page outside the main step flow shows the latest assets across all source videos for the current user.
   - A persistent top-left brand/home logo in the sidebar links back to `https://www.shwsh.co.uk/experiments/aivfx/` from any page, including Asset Library, API Logs, and Admin.

6. **Reports / API Logs**
   - Reports primarily list existing reports for the current source video, without orphaning older saved reports.
   - Quality reports compare original, edited, refined, generated, and merged assets.
   - Custom QC supports two uploaded images or two uploaded videos; video uploads are sampled from the first frame and then every two seconds.
   - Internal source/generated frame pairing for report QC now uses direct frame-index extraction for frame-accurate comparisons.
   - Video comparison reports compare selected generations from the same working range/start frame with aligned frame grids, diff grids, zoomed crops, model settings, input/output resolution, fps, duration, and frame counts.
   - The standalone API playground is served at `/experiments/aivfx/api-test.html`.
   - A nav link opens the API logs page, showing external API jobs with input/output asset previews and errors.

## Current Workflow Model

Internally, the app is moving toward these reusable concepts:

- `Source Video`
- `Working Range`
- `Frame Edit Set`
- `Generation Session`
- `Post Process Session`
- `Report Set`

The UI has already been restructured around those concepts even though storage compatibility is maintained through the existing task/segment/frame/generation records.

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
| LTX 2.3 Pro | Replicate | first frame + last frame image-to-video | Uses `lightricks/ltx-2.3-pro` `task=image_to_video`; this app currently routes LTX only for start/end mode |

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

Where a provider has lower FPS constraints than the source, the app can either:

- preserve all source frames by retiming the prepared provider input, or
- allow provider-side resampling/drop behavior

That behavior is now exposed in the UI for relevant routes as `Preserve source frames`.

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

- `TaskDetail`: task snapshot containing `workflowId`, video metadata, segments, frames, frame variants, segment generations, cleanup tracks, reports, and exports.
- `TaskSummary`: sidebar/list snapshot containing `workflowId`, task status, timestamps, and basic video metadata.
- `JobStatus`: async job state with `type`, `status`, `progress`, `logs`, `error`, and `resultRefs`.
- `ExternalApiRequest`: standalone API request record under the authenticated user.

Storage is currently S3 JSON based. DynamoDB remains a future migration candidate once the data model settles.

## Model Capability Registry

Video-model behavior is now centralized in a backend capability registry:

- `backend/src/generation/capabilities.py`

The registry is the canonical source for model-specific constraints and behavior, including:

- provider identity
- supported route/input modes
- prompt requirements and required markers
- duration and frame-budget limits
- FPS policy
- preserve-frames eligibility
- chunk/extend support
- provider input/preparation profile

The current UI still uses the existing flows, but validation and media-prep decisions are now driven from that registry rather than scattered constants.

When adding or changing a video model, update the backend capability registry first and then wire any provider-specific execution details behind it. Do not add new model limits, prompt requirements, or input-mode support as ad hoc conditionals in page components.

## Generation Mode Registry

UI route behavior is now centralized in a frontend generation-mode registry:

- `frontend/src/lib/generationModeRegistry.ts`

The mode registry is the canonical source for route-level UI behavior, including:

- route label and description
- whether the route requires an end frame
- which Post Process tools are visible for that route

## Task Workflow Registry

Top-level task workflows are now tracked separately from per-segment generation modes:

- backend task metadata: `workflowId`
- frontend workflow registry: `frontend/src/lib/taskWorkflows.ts`
- homepage/frontdoor: root route `#/`

This keeps the current source-video implementation explicit as `source_video_flow` while allowing future workflow shells such as `character_animate_workflow` to reuse the same task chrome, asset library, reports, and provider API paths without overloading `generationInputMode`.

The root route now serves as a workflow chooser rather than automatically jumping into the last task. Existing task routes and direct utility routes continue to work, and the sidebar Fivefold logo returns users to that homepage.

Current mode/tool behavior is:

- `start_video`
  - `Extend`
  - `Reconcile timing`
  - `Tracked keep-mask cleanup`
  - `Merge into source`
- `start_end`
  - `Extend`
  - `Merge into source`
- `start_only`
  - `Extend`

When adding a new creation mode or changing which tools apply to a mode, update this registry and consume it from the UI rather than scattering new `mode === ...` checks across `App.tsx`, `MergeTab.tsx`, or other workflow pages.

## Async Job Types

Current worker job types include:

- `ingest_video`
- `edit_full`
- `edit_patch`
- `quality_match_apply`
- `quality_match_sam`
- `segment_generate`
- `merge_export`
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

The task API is Cognito-authenticated except `GET /health`. Long-running routes return `jobId`; the frontend polls `GET /jobs/{jobId}` while there is active work and backs off once jobs settle, so normal step navigation should not trigger avoidable task/media reload churn.

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

Developer-facing external API routes are documented in [docs/external-api-reference.md](/Users/robinmoore/aivfx-pipeline/docs/external-api-reference.md).

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

See [docs/external-api-reference.md](/Users/robinmoore/aivfx-pipeline/docs/external-api-reference.md) for request schemas, model options, ordered reference-image handling, validation, and auth guidance.

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

Contract sync (frontend generated contracts from backend contract sources):

```bash
npm run sync:contracts
```

Generated files:

- `frontend/src/lib/generated/videoContracts.ts`
- `frontend/src/lib/generated/apiContracts.ts`

Deploy is handled through the existing CDK/static-site workflow used for the live application.

## Deploying To Live

For this project we normally test against live immediately after a completed change set.

The repo now supports two frontend targets:

- `dev`:
  - `https://www.shwsh.co.uk/experiments/aivfx/`
  - path-hosted build
- `prod`:
  - `https://aivfx.shwsh.co.uk/`
  - dedicated root-hosted subdomain build

Subdomain cutover and CloudFront/Route53 instructions:

- [docs/subdomain-prod-cutover.md](/Users/robinmoore/aivfx-pipeline/docs/subdomain-prod-cutover.md)

Typical development deploy sequence:

1. Deploy infra/backend stack

```bash
cd infra
npm install
npm run build
npx cdk deploy AivfxStack --require-approval never --outputs-file cdk-outputs.json
```

2. Build frontend with dev-hosted env

```bash
cd frontend
npm install
npm run build
```

3. Upload frontend bundle

```bash
aws s3 sync frontend/dist s3://shwsh.co.uk/experiments/aivfx/ --delete
```

4. Invalidate CloudFront

```bash
aws cloudfront create-invalidation --distribution-id E3LS87IBDVMSCO --paths "/experiments/aivfx/*"
```

Production frontend build command:

```bash
npm run build:frontend:prod
```

## Baseline Gates

Run these checks before merging refactors:

```bash
npm run lint:frontend
npm run build:frontend
npm run check:backend
npm run build:infra
```

Manual release smoke checklist:

- `docs/manual-smoke-checklist.md`

## Edit Video Trial Mode

The app now includes a trial creation mode focused on source-video editing:

- Mode id: `edit_video`
- Inputs: source working-range video + prompt + optional reference images.
- Reference limits (current simplified policy):
1. Up to 3 references: Seedance 2.0 / Happy Horse 1.0 Video Edit / Kling v3 Omni Video
2. Up to 1 reference: Wan 2.7 VideoEdit / Runway Gen-4 Aleph

Reference images are managed through a shared working-reference strip and picker modal:

1. Upload new reference images in the Edit step.
2. Reuse previous uploads from the same account.
3. Pull in generated stills and current-task frame captures.
4. Keep the ordered working set visible in both Edit and Generate so prompt order stays explicit.

Feature flags:

- `VITE_ENABLE_EDIT_VIDEO_MODE` (default enabled unless explicitly set to `false`)
- `VITE_ENABLE_START_ONLY_MODE` (default disabled; set to `true` to re-enable `start_only`)
