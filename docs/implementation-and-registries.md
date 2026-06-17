# Implementation And Registries

## Purpose

AIVFX is implemented as a workflow-driven application with shared task infrastructure and centralized registries.

The goal of these registries is to keep workflow behavior, mode behavior, and model behavior out of ad hoc page conditionals wherever possible.

## Relationship Model

The main application layers relate to each other like this:

1. `workflow`: selects the broad task shell
2. `mode`: selects the route inside that workflow where applicable
3. `model capability`: constrains what the selected model can do
4. `task data`: persists the user's actual inputs, selections, generations, and reports
5. `origin metadata`: lets asset grids and report builders reason about where an output came from

This is the core reason the app can share `Assets` and `Reports` across multiple workflows without flattening them into one generic generation flow.

## Main Registries

## Task Workflow Registry

Frontend workflow definitions live in:

- [`frontend/src/lib/taskWorkflows.ts`](../frontend/src/lib/taskWorkflows.ts)
- [`frontend/src/lib/workflowSections.ts`](../frontend/src/lib/workflowSections.ts)

These define:

- supported workflow ids
- workflow labels and home-card descriptions
- the shared six-step tab shell

Current workflow ids:

- `source_video_flow`
- `character_animate_workflow`
- `simple_generation_workflow`
- `canvas_workflow` (recognized for shared-contract compatibility, not yet user-facing in the main shell)

## Generation Mode Registry

Frontend generation modes live in:

- [`frontend/src/lib/generationModeRegistry.ts`](../frontend/src/lib/generationModeRegistry.ts)

These define route-level behavior such as:

- required inputs
- whether an end frame is required
- which post-process tools should appear for a mode

Current source-video generation modes:

- `start_video`
- `start_end`
- `start_only`
- `edit_video`

## Character Animate Mode Registry

Character workflow mode and model options live in:

- [`frontend/src/lib/characterAnimate/characterAnimateModeRegistry.ts`](../frontend/src/lib/characterAnimate/characterAnimateModeRegistry.ts)

These define:

- `pose_video`
- `audio_driven`
- which character-animation models are shown for each mode

## Video Model Capability Registry

Backend video-model behavior lives in:

- [`backend/src/generation/capabilities.py`](../backend/src/generation/capabilities.py)

This registry defines model-level behavior such as:

- provider
- allowed mode ids
- min/max duration
- fps budget rules
- whether prompt text is required
- whether specific prompt markers are required
- whether source video is required
- whether chunked generation or extension is supported

This registry is the main backend source of truth for model behavior.

## Prompt Wizard Admin Registry

Centralized prompt-wizard model configuration is handled by:

- [`backend/src/core/prompt_wizard_admin.py`](../backend/src/core/prompt_wizard_admin.py)
- [`backend/src/api/routes_admin.py`](../backend/src/api/routes_admin.py)
- [`frontend/src/pages/AdminPromptWizardPage.tsx`](../frontend/src/pages/AdminPromptWizardPage.tsx)

This is an admin-editable registry layer on top of the underlying model execution infrastructure.

## Tasks, Assets, And Reports

## Task structure

A task is the main unit of work. A task carries:

- `workflowId`
- source media
- segments / scene state
- frame records and variants
- generation records
- post-process outputs
- asset references
- custom reports

## Asset ownership model

Data is stored under Cognito-user-owned prefixes.

Typical namespaces:

- `users/<userId>/tasks/<taskId>/...`
- `users/<userId>/api_requests/...`
- `users/<userId>/api_uploads/...`

This is why migrations must rewrite by Cognito `sub`, not by email alone.

## Output origin metadata

Generation assets use persisted origin metadata so the app can reason about:

- which workflow created an asset
- which step/tool created it
- which creation mode or route it belongs to
- which app surface registered it

Current standard origin fields are:

- `workflowId`
- `stepOrigin`
- `toolOrigin`
- `creationMode`
- `appSurface`

Future workflow-specific origin extensions should be namespaced rather than flattened into new shared top-level fields.

Shared helper files:

- [`backend/src/core/asset_origin.py`](../backend/src/core/asset_origin.py)
- [`frontend/src/lib/generationOrigin.ts`](../frontend/src/lib/generationOrigin.ts)

That origin data is important for consistent asset-grid behavior and report scoping.

## App Surfaces

## Frontend

The frontend provides:

- workflow homepage
- task selection and task creation
- the shared six-step task shell
- workflow-specific tab implementations
- shared asset and report views
- library/picker surfaces
- admin and API log views

## Backend

The backend provides:

- task CRUD and task media routes
- workflow-specific generation routes
- report creation and retrieval
- asset deletion and lifecycle handling
- admin routes
- external API routes
- async job dispatch to workers

## Workers

Background workers handle:

- media processing
- provider integration calls
- long-running generation jobs
- report generation
- post-process operations

## Related Docs

- [App Overview](./app-overview.md)
- [Environments and Deployment](./environments-and-deployment.md)
- [Collaboration and Release](./collaboration-and-release.md)
- [External API Reference](./external-api-reference.md)
