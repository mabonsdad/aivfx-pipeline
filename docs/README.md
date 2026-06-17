# Documentation Index

This documentation set is organized around the current product structure rather than the order the app was built.

## Start Here

If you need to understand how the app works today, read these in order:

1. [App Overview](./app-overview.md)
2. [Source Video Workflow](./workflows/source-video-workflow.md)
3. [Character Animate Workflow](./workflows/character-animate-workflow.md)
4. [Previz Workflow](./workflows/previz-workflow.md)
5. [Implementation and Registries](./implementation-and-registries.md)
6. [Environments and Deployment](./environments-and-deployment.md)
7. [Collaboration and Release](./collaboration-and-release.md)
8. [Canvas Workflow Integration](./canvas-workflow-integration.md)

## What Each Document Covers

### Product and workflow docs

- [App Overview](./app-overview.md): purpose of AIVFX, the shared six-step shell, and the high-level navigation model
- [Source Video Workflow](./workflows/source-video-workflow.md): source-range-led VFX flow, including mode-specific behavior
- [Character Animate Workflow](./workflows/character-animate-workflow.md): character-image-led performance generation from video or audio
- [Previz Workflow](./workflows/previz-workflow.md): prompt-and-reference-led shot generation

### Architecture and implementation docs

- [Implementation and Registries](./implementation-and-registries.md): how workflows, modes, model capabilities, tasks, assets, and reports are wired
- [Environments and Deployment](./environments-and-deployment.md): shared, dev, and prod environments plus deploy and migration commands
- [Collaboration and Release](./collaboration-and-release.md): branch policy, shared-contract rules, PR expectations, and owner-controlled dev/prod promotion
- [Canvas Workflow Integration](./canvas-workflow-integration.md): collaborator-facing seam for the separate canvas workflow, including shared metadata rules and a code-assistant brief

### Reference and operational docs

- [External API Reference](./external-api-reference.md): developer-facing request/response documentation for the external API surface
- [Manual Smoke Checklist](./manual-smoke-checklist.md): validation steps after deploys or larger refactors
- [Production Subdomain Cutover](./subdomain-prod-cutover.md): Route53, CloudFront, and cutover notes for the production host
