# Collaboration And Release

## Purpose

This repo is the single source of truth for the AIVFX frontend, backend, auth, task metadata, and asset contract.

The current six-step app and the planned canvas workflow share:

- Cognito auth and session handling
- task ids and user ids
- asset metadata and origin metadata
- upload/import/delete routes
- environment targeting and deploy process

The canvas workflow is allowed to diverge in frontend layout and workflow-specific backend tools. It should not fork the shared asset, auth, or task contract.

## Branch And Merge Model

- `main` is the protected integration branch.
- `main` is the source for both dev and prod deploys.
- Feature work should use short-lived branches:
  - `feature/canvas-*`
  - `fix/canvas-*`
  - `backend/canvas-*`
- No direct pushes to `main` except for owner-controlled emergency fixes.
- Before final review, branches should be rebased or merged with the latest `main` when they touch shared contracts.

## Review Boundaries

Changes in these areas require explicit owner review before merge:

- `frontend/src/types/*`
- `frontend/src/api/*`
- `backend/src/api/*`
- `backend/src/core/store.py`
- auth or admin-group handling
- task or asset schemas
- asset indexing, import, deletion, or canonical-key behavior
- deploy scripts or infrastructure

Canvas-isolated areas can move faster if they do not break shared contracts:

- canvas-specific UI components
- canvas-specific frontend state
- workflow-scoped backend tools behind dedicated routes
- internal utilities that do not leak incompatible task or asset shapes

## Shared Contract Rules

All uploaded or generated assets must remain interoperable across workflows.

Required top-level ownership and linkage:

- `userId`
- `taskId`
- `workflowId`
- canonical S3 key for the source/output binary
- timestamps

Required origin metadata fields for generated assets:

- `origin.workflowId`
- `origin.stepOrigin`
- `origin.toolOrigin`
- `origin.creationMode` where applicable
- `origin.appSurface`

Workflow-specific metadata should go in namespaced extension blocks rather than new incompatible top-level fields. Example:

- `origin.canvasWorkflow`

Hard rules:

- do not duplicate binaries just to make another workflow see them
- link to the canonical asset key instead
- use shared task/asset registration helpers rather than writing ad hoc metadata shapes

Relevant helpers:

- [`backend/src/core/asset_origin.py`](../backend/src/core/asset_origin.py)
- [`backend/src/generation/maintenance.py`](../backend/src/generation/maintenance.py)

## Workflow Ids

Current recognized workflow ids are:

- `source_video_flow`
- `character_animate_workflow`
- `simple_generation_workflow`
- `canvas_workflow`

`canvas_workflow` is intentionally recognized by the shared contract now so canvas-authored tasks can exist in shared metadata without being misread as source-video tasks. It is not yet a user-facing workflow in the current shell.

## Dev And Prod Control

### Dev

- Dev frontend: `https://www.shwsh.co.uk/experiments/aivfx/`
- Dev backend/auth/storage: current dev stack
- Collaborators open PRs to `main`
- Owner reviews and merges
- Owner deploys shared dev

Deploy commands:

```bash
npm run deploy:infra:dev
npm run deploy:frontend:dev
```

### Prod

- Prod frontend: `https://aivfx.shwsh.co.uk/`
- Prod deploys are owner-only and manually promoted from reviewed `main` commits

Deploy commands:

```bash
npm run deploy:infra:prod
npm run deploy:frontend:prod
```

Record the `main` commit hash promoted to prod and run the smoke checklist after release.

## Pull Request Expectations

Every PR should state:

- user-facing change
- whether shared contracts changed
- whether shared storage/schema changed
- whether asset behavior changed
- whether deploy or infra is affected
- routes/workflows/tools touched
- smoke-test steps
- rollback note if shared behavior changed

Use the repo PR template:

- [`.github/pull_request_template.md`](../.github/pull_request_template.md)

## GitHub Settings To Apply

Apply these branch protection rules to `main` in GitHub:

- require pull requests before merge
- require at least one review
- disallow force pushes
- require status checks for PR CI before merge

These settings are not stored in the repo itself and must be applied in GitHub repository settings.

## First Canvas Integration Checks

Before enabling the canvas workflow in shared dev:

- confirm canvas-created assets appear in the shared asset library via metadata only
- confirm current-app assets can be consumed by the canvas workflow
- confirm canvas-created tasks with `workflowId=canvas_workflow` do not break task listing or auth flows
- confirm shared deploy paths still work with both surfaces in one repo
