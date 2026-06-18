# AIVFX

AIVFX is a workflow-based application for AI-assisted video and image generation. It gives different creative workflows a consistent operating shell so users can move from source selection, to reference preparation, to generation, to review and reporting without learning a new interface each time.

The application currently supports three workflows:

- `VFX`: source-video-led video transformation and shot replacement
- `Character Animate`: character performance generation from pose video or audio
- `Previz`: text-and-reference-led scene and shot generation

## Core Idea

AIVFX is organized around a consistent six-step flow:

1. `Select`
2. `Edit`
3. `Generate`
4. `Post Process`
5. `Assets`
6. `Reports`

Each workflow reuses this shell, but the tools inside each step differ according to the workflow and, where relevant, the selected creation mode.

That means the user experience stays structurally stable while the underlying media inputs, generation models, and post-process tools change.

## Current Workflows

| Workflow | Purpose | Typical inputs | Main output |
| --- | --- | --- | --- |
| `VFX` | Change style, lighting, motion treatment, or content of a source video | Source video, captured frames, edited frames, optional reference images/audio | Generated and merged video outputs |
| `Character Animate` | Turn a character still into a performance using driving motion or audio | Character image, source video or source audio, optional prompt | Character animation video |
| `Previz` | Build storyboard-like shots from text plus reference imagery | Scene prompt, uploaded/generated references, selected frames | Previz video clips |

Detailed workflow pages:

- [Source Video Workflow](./docs/workflows/source-video-workflow.md)
- [Character Animate Workflow](./docs/workflows/character-animate-workflow.md)
- [Previz Workflow](./docs/workflows/previz-workflow.md)

## Shared Six-Step Flow

### 1. Select
Choose or upload the core source material for the task and set the context for downstream work.

Depending on workflow, this can include:

- uploading a source video or audio file
- setting a working range or scene scope
- choosing a scene aspect ratio
- selecting a creation mode
- adding initial references

### 2. Edit
Prepare the still-image inputs that generation will depend on.

Depending on workflow, this can include:

- capturing source frames
- editing first and last frames
- creating reference sheets or reference stills
- selecting a character reference
- curating storyboard frames

### 3. Generate
Run the workflow's main generation tool using the references prepared earlier.

This step is where workflow-specific models are used, for example:

- source-motion video generation
- source-video edit models
- character animation models
- previs video generation from selected frames

### 4. Post Process
Operate on generated results after the main generation pass.

Depending on workflow and mode, this can include:

- timing reconciliation
- extension / continuation
- cleanup / mask-based correction
- merge back into source
- upscale / export follow-on steps

### 5. Assets
Review and manage outputs and references for the current task, and access the broader library views.

This includes:

- generated videos
- merged videos
- generated images and captured frames
- uploaded references
- audio assets where relevant

### 6. Reports
Create and review QC, comparison, and workflow-specific report outputs.

This includes:

- asset-linked quality reports
- comparison reports
- workflow-specific review reports
- API log inspection through separate admin/user views

## How The App Is Structured

AIVFX combines a few consistent concepts.

### Workflow
A `workflow` defines the overall task type.

Current workflow ids:

- `source_video_flow`
- `character_animate_workflow`
- `simple_generation_workflow`

The workflow controls:

- homepage presentation
- which tools appear within each of the six steps
- which generation routes are valid
- how outputs are interpreted in reports and asset views

There is also a reserved shared-contract workflow id:

- `canvas_workflow`

This is recognized by the backend and the current app so canvas-authored tasks can coexist in the same metadata and asset store, but it is not yet exposed as a user-facing workflow in the main shell.

### Mode
A `mode` defines a generation route within a workflow.

For the source-video workflow, modes include:

- `start_video`
- `start_end`
- `start_only`
- `edit_video`

For the character workflow, the main modes are:

- `pose_video`
- `audio_driven`

Previz currently uses a single previs-specific generation path rather than a user-facing mode picker.

### Reports
Reports are task-scoped review artifacts built from selected outputs.

Depending on workflow and asset type, reports may compare:

- source vs generated
- original vs edited stills
- multiple generated variants
- previs frame selections and resulting clips

### Registries
AIVFX uses registries so that behavior is defined centrally instead of being spread through page-level conditionals.

The main registries are:

- `Task workflow registry`: defines the supported workflows and the shared step shell
- `Generation mode registry`: defines route-level behavior such as required inputs and available post-process tools
- `Video model capability registry`: defines model-level limits and behaviors such as allowed modes, prompt requirements, duration limits, and whether a source video is required
- `Prompt wizard admin registry`: controls centralized prompt-wizard model configuration used by the backend admin surface

See [Implementation and Registries](./docs/implementation-and-registries.md).

## Documentation Map

Start here if you are reorienting yourself to the current app:

1. [Docs Index](./docs/README.md)
2. [App Overview](./docs/app-overview.md)
3. workflow-specific pages
4. [Implementation and Registries](./docs/implementation-and-registries.md)
5. [Environments and Deployment](./docs/environments-and-deployment.md)
6. [Collaboration and Release](./docs/collaboration-and-release.md)

### Product / app documentation
- [App Overview](./docs/app-overview.md)
- [Source Video Workflow](./docs/workflows/source-video-workflow.md)
- [Character Animate Workflow](./docs/workflows/character-animate-workflow.md)
- [Previz Workflow](./docs/workflows/previz-workflow.md)
- [Implementation and Registries](./docs/implementation-and-registries.md)
- [Environments and Deployment](./docs/environments-and-deployment.md)
- [Collaboration and Release](./docs/collaboration-and-release.md)

### Supporting documentation
- [External API Reference](./docs/external-api-reference.md)
- [Manual Smoke Checklist](./docs/manual-smoke-checklist.md)
- [Production Subdomain Cutover](./docs/subdomain-prod-cutover.md)

## Repository Layout

- `frontend/`: React, TypeScript, Vite, Tailwind, TanStack Query, Zustand
- `backend/`: Python Lambda API and worker code
- `infra/`: AWS CDK stacks and outputs
- `docs/`: product, implementation, and operational documentation
- `scripts/`: migration, deploy, and operational helpers

## Common Commands

Use these from the repo root:

```bash
npm run deploy:infra:shared
npm run deploy:infra:dev
npm run deploy:infra:prod
npm run deploy:frontend:dev
npm run deploy:frontend:prod
```

For routine branch testing without deploying, use the local frontend workflow documented in [README-local.md](./README-local.md).

Data migration helpers:

```bash
python3 scripts/clone_prod_task_to_dev.py --task-id TASK_ID --target-email YOUR_LOGIN_EMAIL
python3 scripts/migrate_user_data.py --source-email SOURCE --target-email TARGET --source-outputs infra/cdk-outputs.shared.json --target-outputs infra/cdk-outputs.dev.json --source-label shared --target-label dev --dry-run
```
