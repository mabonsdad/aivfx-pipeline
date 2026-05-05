# Sister App Scaffolding Plan

This document defines how to scaffold a sister app that reuses current APIs, contracts, and workflow modules while keeping the existing app stable.

This is an implementation guide, not the final product spec.

## Goals

- Keep the current app unchanged in behavior.
- Create a new app entrypoint with independent routes and build target.
- Reuse shared contract, query, and orchestration hooks wherever possible.
- Minimize duplicated business logic in app-level components.

## Recommended Shape

Use a monorepo frontend layout with two app shells:

```text
frontend/
  src/
    apps/
      main/                  # existing app shell
      sister/                # new app shell
    features/                # reusable domain UI + hooks
    hooks/                   # shared orchestration hooks (already extracted)
    lib/                     # shared registries/config/utilities/contracts
    types/                   # shared app types
```

## Reuse-First Module Boundaries

The sister app should consume these existing shared layers first:

- Contracts/types:
  - `frontend/src/lib/generated/*`
  - `frontend/src/types/*`
- API client/auth/config:
  - `frontend/src/api/client.ts`
  - `frontend/src/lib/auth.ts`
  - `frontend/src/lib/config.ts`
- Orchestration hooks already extracted:
  - `frontend/src/hooks/useTaskDataQueries.ts`
  - `frontend/src/hooks/useAssetLibraryState.ts`
  - `frontend/src/hooks/useAssetsTabContexts.ts`
  - `frontend/src/hooks/useGenerationConfigState.ts`
  - `frontend/src/hooks/useGenerationPromptGuidance.ts`
  - `frontend/src/hooks/useSelectedSegmentPreview.ts`
  - `frontend/src/hooks/useCurrentWorkingReferenceState.ts`

## App Bootstrap Sequence

1. Add sister app entrypoint and route root
- Create `frontend/src/apps/sister/SisterApp.tsx`.
- Add a route namespace (for example `/sister/*`) without changing current routes.

2. Add shared app shell primitives
- Reuse auth/session bootstrap and top-level error handling patterns.
- Reuse loading/error UI patterns for consistency and speed.

3. Start read-only first
- Implement list/select flows for tasks/assets/reports before mutations.
- Use `useTaskDataQueries` + shared API client to avoid duplicated polling logic.

4. Add write flows behind isolated actions
- Add mutation features one-by-one (generate, cleanup, merge, etc.) after read-only baseline is stable.

5. Keep provider/model configuration in shared modules
- Put provider capability/config mapping in shared `lib`/`hooks`.
- Sister app should only choose modes; not re-implement provider rules.

## Suggested Initial File Scaffold

```text
frontend/src/apps/sister/
  SisterApp.tsx
  routes.tsx
  pages/
    SisterDashboardPage.tsx
    SisterTaskPage.tsx
  features/
    task-list/
    task-detail/
    outputs/
```

## Testing Gates For Sister Scaffolding

After each scaffolding slice:

- `npm run lint:frontend`
- `npm run build:frontend`
- `npm run test:backend`

Manual checks:

- Existing app route still works end-to-end.
- Sister route loads and authenticates.
- Sister read-only task list/details render correctly.
- No contract drift between frontend and backend payloads.

## Guardrails

- No behavior changes to existing app workflows while scaffolding sister app.
- Prefer extraction + reuse over copy/paste.
- Keep app-specific UI composition in `apps/*`; keep business logic in shared `hooks`/`lib`.
- Add new shared utilities only when used by both apps.

## Ready For Full Spec

When you provide the full sister app spec, this scaffold should let us:

- plug in domain-specific pages quickly,
- map required flows to existing modules,
- and implement missing shared abstractions only where gaps remain.
