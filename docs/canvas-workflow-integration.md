# Canvas Workflow Integration

## Purpose

This document is for the collaborator building the separate canvas-based workflow.

It describes the platform seam that must stay shared with the rest of AIVFX so that:

- canvas-created tasks can live in the same metadata store
- canvas-created assets can appear in the existing asset library and picker flows
- current-app assets can be reused by the canvas workflow without binary duplication
- auth, task ownership, and deploy environments remain consistent

This is not a product-spec for the canvas UX. The collaborator is free to design a different UI shell and workflow shape.

## Fixed Platform Contract

The canvas workflow must use:

- `workflowId = canvas_workflow`
- the same Cognito-backed auth/session model
- the same task ids and user ids
- the same canonical S3 asset keys rather than duplicated binary copies
- the same shared task and asset registration patterns

Canvas tasks are already recognised by the current app, but the current shell does not expose canvas authoring controls.

## Asset Rules

Every generated asset should remain consumable by the shared asset library and any future project-sharing layer.

Required metadata for generated assets:

- `taskId`
- `userId`
- `workflowId`
- canonical output key
- created / updated timestamps
- `origin.workflowId`
- `origin.stepOrigin`
- `origin.toolOrigin`
- `origin.creationMode` where relevant
- `origin.appSurface`

Workflow-specific metadata should be placed in namespaced extension blocks. For canvas, prefer:

- `origin.canvasWorkflow`

Do not:

- duplicate a binary only so another workflow can see it
- invent a parallel top-level asset shape
- bypass shared metadata registration helpers

## Shared Helpers And Files

Use these as the contract source of truth:

- [`backend/src/core/asset_origin.py`](../backend/src/core/asset_origin.py)
- [`backend/src/generation/maintenance.py`](../backend/src/generation/maintenance.py)
- [`frontend/src/lib/generationOrigin.ts`](../frontend/src/lib/generationOrigin.ts)
- [`frontend/src/lib/taskWorkflows.ts`](../frontend/src/lib/taskWorkflows.ts)
- [`frontend/src/types/api.ts`](../frontend/src/types/api.ts)

Changes in these areas need owner review:

- `frontend/src/types/*`
- `frontend/src/api/*`
- `backend/src/api/*`
- `backend/src/core/store.py`
- auth or admin-group logic
- task or asset schema changes
- asset import / indexing / deletion behavior
- deploy scripts or infra

## Suggested Build Shape

The collaborator should be able to move quickly inside these boundaries:

- add a separate route family or frontend shell for the canvas UI
- add canvas-specific components and state
- add workflow-specific backend routes or jobs
- add workflow-specific metadata inside namespaced fields

Recommended sequence:

1. create canvas tasks with `workflowId=canvas_workflow`
2. ensure canvas uploads/generations register shared origin metadata
3. ensure canvas-created assets appear in shared asset/library views
4. ensure current-app assets can be imported or linked into canvas flows without duplication
5. only then expand workflow-specific tools and UI

## Pull Request Expectations

Every canvas PR should state:

- user-facing change
- whether shared contract changed
- whether shared storage/schema changed
- whether asset behavior changed
- whether deploy/infra changed
- exact routes/files touched
- smoke-test steps

Use the repo PR template:

- [`.github/pull_request_template.md`](../.github/pull_request_template.md)

## Initial Smoke Tests

Before merging any first-pass canvas integration:

1. create a canvas task and confirm it lists without breaking the current shell
2. generate or upload an asset from canvas and confirm it appears in shared asset views
3. import or reuse an existing current-app asset from canvas without binary duplication
4. confirm delete behavior still targets the canonical asset, not just local metadata
5. confirm auth works against the shared dev environment

## Brief For A Code Assistant

The collaborator can paste the following into their coding assistant:

```text
You are working inside the AIVFX monorepo on a separate canvas-based workflow.

Hard constraints:
- Use the existing shared backend/auth/storage contract.
- Use workflowId `canvas_workflow`.
- Do not create a separate asset model or duplicate binaries just to make assets visible across workflows.
- Any generated asset must register shared origin metadata:
  - origin.workflowId
  - origin.stepOrigin
  - origin.toolOrigin
  - origin.creationMode where applicable
  - origin.appSurface
- Put canvas-specific metadata in a namespaced extension block such as origin.canvasWorkflow.
- Reuse shared helpers and types rather than inventing incompatible shapes.

Files that define the contract:
- backend/src/core/asset_origin.py
- backend/src/generation/maintenance.py
- frontend/src/lib/generationOrigin.ts
- frontend/src/lib/taskWorkflows.ts
- frontend/src/types/api.ts
- docs/collaboration-and-release.md
- docs/canvas-workflow-integration.md

Review boundary:
- If you need to change shared task/asset schemas, auth, asset deletion/import/indexing, frontend API types, backend API contracts, or deploy/infra, keep the change small and make it obvious in the PR because it requires owner review.

Freedom:
- You can build a different canvas-specific frontend shell, state model, and workflow-specific backend routes/tools as long as they register tasks and assets back into the shared contract cleanly.
```
