# Character Tool Notes

This document records the current Wan Animate integration behavior and the recommended structure for a future dedicated Character Animation workflow.

## Current State

The main `Generate Video` workflow is still focused on general VFX segment replacement.

Wan2.2 Animate is now available as one of the first-frame + video generation options, but it is treated as a constrained provider lane rather than a complete character-animation product surface.

Current behavior:

- The app sends reference image and reference video inputs.
- Prompt text is omitted for Wan Animate unless LoRA support is added, because the provider rejects `positivePrompt` without LoRA.
- Input dimensions are conformed to one of the provider-supported Wan2.2 sizes.
- The output is handled like other generated segment variants and can be compared, cleaned, and merged.

The app does not yet expose a dedicated character setup, identity-locking, wardrobe reference, or performance-transfer workflow.

## Wan2.2 Animate Integration Lessons

### 1. Reference Input Shape

Observed provider error:

```text
invalidInputsImage
```

Working shape:

```json
{
  "inputs": {
    "referenceImages": ["https://.../start_frame.png"],
    "referenceVideos": ["https://.../segment.mp4"]
  }
}
```

Use arrays of string values, not nested objects.

### 2. Prompt Restriction

Observed provider error:

```text
wanAnimatePositivePromptRequiresLora
```

Implication:

- `positivePrompt` cannot be sent unless at least one LoRA is provided.

Current handling:

- The worker omits `positivePrompt` for Wan Animate.
- UI help should make clear that this route is reference-driven, not prompt-driven, until LoRA support is implemented.

### 3. Strict Dimensions

Observed provider error:

```text
unsupportedDimensions
```

Supported dimension families include:

- `1280x720`, `1024x576`, `848x480`
- `720x1280`, `576x1024`, `480x848`
- `960x960`, `768x768`, `640x640`
- `1104x832`, `896x672`, `736x560`
- `832x1104`, `672x896`, `560x736`

Current handling:

- The app picks the nearest supported Wan2.2 resolution by source aspect ratio.
- Returned output is probed and conformed for timeline merge where needed.

### 4. Behavior Expectations

- Wan Animate behaves like a reference-guided character motion/replace model.
- It is not a strict first-frame lock model.
- The edited first frame is guidance, not a guaranteed exact first output frame.
- Output timing may need offset/trim handling during merge.

## Current Provider Code Locations

- UI model routing: `frontend/src/App.tsx`
- Generate Video UI: `frontend/src/pages/workflow/GenerateTab.tsx`
- API validation/routing: `backend/src/api_handler.py`
- Worker orchestration: `backend/src/workers/processor.py`
- Provider adapters:
  - `backend/src/integrations/runware_video.py`
  - `backend/src/integrations/kling.py`
  - `backend/src/integrations/runway.py`
  - `backend/src/integrations/luma.py`
  - `backend/src/integrations/fal.py`
  - `backend/src/integrations/replicate.py`

## Recommended Dedicated Character Animation Workflow

A future Character Animation workflow should be separate from the current segment-replacement UI.

Suggested top-level flow:

1. Character Setup
2. Motion Source
3. Provider + Controls
4. Generate + Compare
5. Insert / Merge

Suggested normalized request:

```json
{
  "character": {
    "subjectImageVariantId": "...",
    "driverVideoSegmentId": "...",
    "endFrameVariantId": "...",
    "wardrobeReferenceIds": [],
    "loraIds": []
  },
  "providerOptions": {
    "provider": "runware|runway|kling",
    "model": "...",
    "width": 1280,
    "height": 720
  }
}
```

Recommended capability matrix:

- accepts prompt
- requires LoRA for prompt
- supports start image
- supports end image
- supports driving video
- supports identity/reference image
- allowed resolutions
- max duration
- expected output fps
- whether source-frame offset estimation is required

Candidate provider lanes:

- Runware Wan2.2 Animate
- Runway Act-Two
- Kling Motion Control

Recommended storage separation:

```text
users/{userId}/tasks/{taskId}/character_generations/{characterGenerationId}/...
```

This keeps standard segment generations, cleanup tracks, and future character-specific metadata from colliding.

## Future Checklist

- Add a `Character Animate` page or workflow tab.
- Add backend schemas for character-specific generation requests.
- Add provider capability preflight validation.
- Add LoRA support for Wan Animate prompt control.
- Add Runway Act-Two adapter if selected.
- Add Kling Motion Control adapter if selected.
- Add character QC metrics for identity retention, motion transfer, and temporal stability.
- Add merge defaults tuned for performance-transfer outputs.
