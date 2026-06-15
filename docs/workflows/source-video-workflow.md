# Source Video Workflow

## Purpose

The Source Video Workflow is the main VFX workflow. It is designed for changing or replacing parts of a source video while keeping a selected source range central to the process.

Typical uses:

- restyling a shot
- replacing content while preserving source timing
- generating alternatives from edited frames plus source motion
- editing the source video directly with prompt-led video-edit models

## Step Behavior

### Select
Typical actions:

- upload a source video
- ingest media metadata and frame/thumbnail context
- define the working range
- choose a creation mode
- optionally define crop/region context

### Edit
Typical actions:

- capture start and end frames
- edit source frames
- upload or create reference images
- prepare the still inputs that generation depends on

### Generate
This step uses the selected mode and model to produce new video outputs.

### Post Process
This is where source-aware follow-on tools appear.

Typical actions:

- reconcile timing
- merge generated output into source
- run tracked cleanup where supported
- extend or continue outputs where supported

### Assets
Shows task-scoped generated, merged, and still-image assets.

### Reports
Supports QC and comparison reporting on selected outputs.

## Modes

The Source Video Workflow makes the heaviest use of the mode registry.

### `start_video`
Use the source segment motion with an edited start frame.

### `start_end`
Animate between edited start and end frames.

### `start_only`
Generate from a start frame without using source motion.

### `edit_video`
Use source video plus prompt, with optional reference imagery, for direct video-edit style generations.

## Why This Workflow Is Distinct

This workflow is the only current workflow that is strongly tied to:

- working-range selection on a source video
- merge-back into source
- timing reconciliation against a source range
- source-video-aware edit modes

## Related Docs

- [App Overview](../app-overview.md)
- [Implementation and Registries](../implementation-and-registries.md)
