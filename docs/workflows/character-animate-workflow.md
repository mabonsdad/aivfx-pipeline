# Character Animate Workflow

## Purpose

The Character Animate Workflow is for turning a character still into a performed animation.

The workflow reuses the shared six-step shell, but its generation routes are centered on character reference imagery plus either motion video or audio.

Typical uses:

- actor-to-character motion transfer
- lip sync / speech-driven character animation
- stylized character performance generation

## Step Behavior

### Select
Typical actions:

- upload source video or audio
- set the working range for the performance segment
- choose the character animation mode

### Edit
Typical actions:

- select or upload the character image
- create reference imagery where needed
- prepare the visual anchor for generation

### Generate
This step submits the current character setup to a supported character model.

### Post Process
This workflow reuses the shared post-process shell but with a narrower toolset than source-video VFX.

### Assets
Shows generated character clips, references, and relevant supporting assets.

### Reports
Uses the same shared reporting infrastructure as the other workflows.

## Modes

The character workflow currently exposes two primary modes.

### `pose_video`
Character image plus driving video.

Current supported model family includes:

- Runway Act-Two
- Kling 3.0 Motion Control
- ByteDance Seedance 2.0 Reference to Video

### `audio_driven`
Character image plus source audio.

Current supported model family includes:

- ByteDance OmniHuman v1.5
- ByteDance Seedance 2.0 Reference to Video

## Distinctive Characteristics

Compared with the source-video workflow, this workflow is centered on:

- a character reference image as the key visual anchor
- either pose-video or audio-driven performance
- model-specific duration and modality limits
- optional prompt use depending on model

## Related Docs

- [App Overview](../app-overview.md)
- [Implementation and Registries](../implementation-and-registries.md)
