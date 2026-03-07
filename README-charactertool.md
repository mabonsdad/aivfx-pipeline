# Character Tool Notes (Planned Separate Workflow)

This document captures integration lessons from Wan2.2 Animate errors and outlines a clean structure for a future character-animation variant of this app.

## Current decision

- Keep the main `Generate Video` workflow focused on general VFX segment replacement.
- Use `wan2.2-a14b` only in the `start frame only` tab for now.
- Do not expose `wan2.2-animate` in the current main UI flow.

## Wan2.2 Animate integration lessons

### 1) `inputs.referenceImages` / `inputs.referenceVideos` format

Observed API error:
- `invalidInputsImage`

Fix:
- Use arrays of string values, not nested objects.
- Valid values: public URL, UUID v4, data URI, or base64 image/video value (per Runware docs).

Working shape:

```json
{
  "inputs": {
    "referenceImages": ["https://.../start_frame.png"],
    "referenceVideos": ["https://.../segment.mp4"]
  }
}
```

### 2) `positivePrompt` restriction on Wan Animate

Observed API error:
- `wanAnimatePositivePromptRequiresLora`

Implication:
- `positivePrompt` cannot be sent unless at least one LoRA is provided.

Current handling:
- Omit `positivePrompt` in Wan Animate requests.
- In UI, hide prompt input when Wan Animate is active (for this workflow).

### 3) Strict width/height constraints

Observed API error:
- `unsupportedDimensions`

Supported dimensions include:
- `1280x720`, `1024x576`, `848x480`
- `720x1280`, `576x1024`, `480x848`
- `960x960`, `768x768`, `640x640`
- `1104x832`, `896x672`, `736x560`
- `832x1104`, `672x896`, `560x736`

Current handling:
- Pick nearest supported Wan2.2 resolution by aspect ratio from source media.

### 4) Behavior expectations

- Wan Animate behaves like a character motion/replace model driven by references.
- It is not a strict first-frame lock model.
- Edited start frames are guidance, not guaranteed exact first-frame adherence.

## Current code structure for video providers

- UI model routing: `frontend/src/App.tsx`
  - `GENERATION_MODELS_BY_INPUT`
  - `generateSegmentMutation`
- API validation/routing: `backend/src/api_handler.py`
- Worker orchestration: `backend/src/workers/processor.py`
  - `_handle_segment_generate`
  - frame/segment preparation
  - provider dispatch
- Provider adapters:
  - Runware video: `backend/src/integrations/runware_video.py`
  - Kling via Runware: `backend/src/integrations/kling.py`
  - Runway: `backend/src/integrations/runway.py`
  - Luma: `backend/src/integrations/luma.py`

## Recommended architecture for a separate Character Animation workflow

## 1) Separate UI workflow

Add a dedicated top-level tab, for example:
- `Character Animate`

Do not mix this with the current segment-replacement controls.

Suggested sub-steps:
1. Character Setup
2. Motion Source
3. Provider + Controls
4. Generate + Compare
5. Insert/Merge

## 2) Separate request contract

Add a dedicated generation mode, for example:
- `character_wan_animate`
- `character_runway_act_two`
- `character_kling_motion_control`

Use a normalized payload shape:

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

## 3) Provider adapters with capability matrix

Create a small capability table to drive UI and validation:
- accepts prompt?
- requires LoRA for prompt?
- supports start/end images?
- supports driving video?
- allowed resolutions
- max duration

This avoids provider-specific errors appearing late in the job.

## 4) Metadata and asset separation

Store character-run metadata separately from standard segment generations:
- separate keys in task JSON (for example `characterGenerations`)
- separate asset folders (for example `segments/{id}/character/{genId}/...`)

This keeps merge/export logic clean and avoids confusion in report views.

## 5) Merge strategy

Character results often drift in timing and composition.
Use the advanced merge controls already implemented (trim/offset/feather) and default to:
- explicit preview of entry/exit boundaries
- conservative feather defaults
- optional hard-cut mode for QC

## 6) Candidate provider lanes

- Runware Wan2.2 Animate:
  - reference image + driving video
  - strict dimension constraints
  - prompt only with LoRA

- Runway Act-Two:
  - character-performance lane
  - model-specific input constraints and motion semantics

- Kling Motion Control:
  - controlled motion from source guidance
  - provider-specific control strength and duration constraints

## Implementation checklist (future)

- [ ] Add `Character Animate` tab and state store
- [ ] Add backend request schema for character modes
- [ ] Implement capability matrix and preflight validation
- [ ] Add Runway Act-Two adapter
- [ ] Add Kling Motion Control adapter
- [ ] Add character-specific report block (identity retention + temporal stability metrics)
- [ ] Add dedicated QA presets for character replacement shots
