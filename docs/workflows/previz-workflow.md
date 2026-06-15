# Previz Workflow

## Purpose

The Previz Workflow is for turning a scene idea into generated storyboard-like shots.

It combines:

- a scene prompt
- uploaded or created reference images
- selected frame references
- a previs-specific generation route

Typical uses:

- fast visual concepting
- scene blocking and exploration
- turning a set of references into candidate motion shots

## Step Behavior

### Select
Typical actions:

- define the scene prompt
- choose the scene aspect ratio
- upload or create scene reference images
- select which references should drive the scene setup

### Edit
Typical actions:

- turn selected references into frame candidates
- curate and order frame references
- select the frames that will drive generation

### Generate
This step creates previs video outputs from:

- the scene prompt
- selected frame references
- the chosen previs model
- duration and aspect-ratio settings

### Post Process
Previz uses the shared post-process shell, but it does not use the source-video-specific tools that assume source range reconciliation.

### Assets
Shows generated previs clips and reference imagery used in the task.

### Reports
Supports shared reporting plus previs-specific review outputs.

## Model Path

Previz currently uses a workflow-specific generation route rather than the source-video generation-mode picker.

Current model options include:

- `veo_3_1`
- `happy_horse_1_0`
- `seedance_2_0`

## Distinctive Characteristics

Compared with the other workflows, previs is centered on:

- prompt-led scene ideation
- selected image references instead of source range editing
- a synthetic scene segment rather than a source-video timeline segment
- frame selection as the direct precursor to generation

## Related Docs

- [App Overview](../app-overview.md)
- [Implementation and Registries](../implementation-and-registries.md)
