# App Overview

## Purpose

AIVFX is a multi-workflow application for generating, refining, reviewing, and reporting on AI-assisted video outputs.

It is designed around a stable six-step workflow shell so that different creative tasks can reuse the same operational structure:

1. `Select`
2. `Edit`
3. `Generate`
4. `Post Process`
5. `Assets`
6. `Reports`

This gives users a consistent way to move through tasks even when the underlying models, media types, and outputs differ.

## The Six-Step Shell

### Select
This step establishes the task context.

Typical responsibilities:

- upload or choose source media
- define working range or scene scope
- select a creation mode where applicable
- choose scene aspect ratio in previs
- set up references that later steps depend on

### Edit
This step prepares still-image inputs and references.

Typical responsibilities:

- capture source frames
- edit first/last frames
- create or upload reference stills
- select character stills
- build scene and frame references in previs

### Generate
This step runs the primary model action for the current workflow.

Typical responsibilities:

- submit source-driven video generations
- run source-video edit models
- drive character animation from video or audio
- create previs shots from selected frames and prompt

### Post Process
This step operates on completed generations.

Typical responsibilities:

- reconcile timing
- continue or extend outputs
- merge back into source where relevant
- perform cleanup or correction workflows
- expose follow-on export or upscale actions

### Assets
This step provides task-level review and management of outputs.

Typical responsibilities:

- inspect generated/merged media
- review task-wide references and stills
- delete or reuse assets
- select outputs for reports

### Reports
This step turns task outputs into review artifacts.

Typical responsibilities:

- QC reports
- side-by-side comparisons
- previs review outputs
- task-scoped report browsing

## Current Workflows

| Workflow | Internal id | Primary input shape | Mode model |
| --- | --- | --- | --- |
| `VFX` | `source_video_flow` | source video plus derived stills/references | explicit creation-mode picker |
| `Character Animate` | `character_animate_workflow` | character still plus video or audio | explicit creation-mode picker |
| `Previz` | `simple_generation_workflow` | scene prompt plus selected references | single previs route |

### Source Video Workflow
Optimized for source-driven VFX work where a selected video segment remains central.

See [Source Video Workflow](./workflows/source-video-workflow.md).

### Character Animate Workflow
Optimized for turning a character image into a performance using either pose video or audio.

See [Character Animate Workflow](./workflows/character-animate-workflow.md).

### Previz Workflow
Optimized for building generated video shots from a scene prompt plus selected image references.

See [Previz Workflow](./workflows/previz-workflow.md).

## Core Structural Concepts

### Workflow
A workflow determines the broad task type and controls which tools appear inside the six shared steps.

### Mode
A mode determines a particular creation route within a workflow.

The clearest example is the source-video workflow, which supports multiple ways of generating video from source and edited inputs.

### Report
A report is a task-scoped review artifact built from selected assets. Reports are shared across workflows, but the valid comparisons differ according to the workflow and the asset origins involved.

### Registries
Behavior is centralized in registries so the app can grow without duplicating model and routing logic in page components.

The important registries are documented in [Implementation and Registries](./implementation-and-registries.md).

### Task
A task is the main unit of work. A task belongs to one workflow and contains the task's source media, references, generations, assets, and reports.

## How The Concepts Fit Together

The app structure is intentionally layered:

1. `workflow`: defines the task type and the tools shown inside the six-step shell
2. `mode`: defines a creation route inside a workflow where a mode picker exists
3. `model capability`: defines what a specific model can accept and produce
4. `task`: stores the user's actual work
5. `asset`: stores generated or uploaded media linked back to task/workflow origin metadata
6. `report`: packages selected assets into a review surface

## Navigation Model

The app uses:

- a workflow homepage with one card per workflow
- task selection within a workflow
- a consistent six-step navigation inside a task
- task-wide library and reporting surfaces shared across workflows

## Related Docs

- [Implementation and Registries](./implementation-and-registries.md)
- [Environments and Deployment](./environments-and-deployment.md)
- [External API Reference](./external-api-reference.md)
