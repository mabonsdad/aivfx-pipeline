# Local Testing Quickstart

Use this for routine frontend work on a feature branch without deploying to the shared dev URL.

## Default Workflow

Run the frontend locally against the current dev backend, Cognito, and shared storage:

```bash
npm run local:frontend:dev
```

This does two things:

1. writes `frontend/.env.local` from `infra/cdk-outputs.dev.json`
2. starts Vite on `http://localhost:5173/`

The localhost callback is already allowed in Cognito.

## Other Local Targets

If you need to point your local frontend at another environment:

```bash
npm run local:frontend:prod
npm run local:frontend:shared
```

## Env Only

If you only want to refresh local environment variables without starting the dev server:

```bash
npm run setup:frontend:local:dev
npm run setup:frontend:local:prod
npm run setup:frontend:local:shared
```

## Recommended Team Process

- work on a feature branch locally
- test UI changes on localhost first
- merge reviewed work into `main`
- deploy shared dev from `main`
- deploy prod from a reviewed `main` commit only

Do not use the shared dev URL for routine branch testing. That environment is now the team integration environment.

## Notes

- `frontend/.env.local` is gitignored
- default localhost URL is `http://localhost:5173/`
- if you want another localhost port or callback path, add it to the Cognito app client first
- local frontend testing still talks to the selected environment's real API and metadata store, so actions you take there are real

## Useful Commands

Frontend checks:

```bash
npm run lint:frontend
npm run build:frontend
```

Shared deploys:

```bash
npm run deploy:frontend:dev
npm run deploy:frontend:prod
```
