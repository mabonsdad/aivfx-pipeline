# Environments And Deployment

## Environment Model

AIVFX currently operates across three meaningful environment layers.

### Shared legacy environment

- stack outputs: `infra/cdk-outputs.shared.json`
- purpose: long-lived shared environment and legacy user/task data
- current role: source of historical data and migration origin

### Current dev environment

- stack outputs: `infra/cdk-outputs.dev.json`
- frontend: `https://www.shwsh.co.uk/experiments/aivfx/`
- purpose: active development environment with isolated backend/auth/storage

### Current prod environment

- stack outputs: `infra/cdk-outputs.prod.json`
- frontend: `https://aivfx.shwsh.co.uk/`
- purpose: isolated production environment

## Cognito Pools

Current active pools are:

- dev: `eu-west-2_Pen5tH6GN`
- prod: `eu-west-2_1kgY649Nr`
- legacy shared: `eu-west-2_BgCd5ECre`

Admin access is group-based. The relevant group is typically:

- `aivfx-admin`

## Common Deploy Commands

Run from the repo root:

```bash
npm run deploy:infra:shared
npm run deploy:infra:dev
npm run deploy:infra:prod
npm run deploy:frontend:dev
npm run deploy:frontend:prod
```

Frontend deploys now include an automatic hosted-page verification step. After upload and CloudFront invalidation, the deploy script checks that:

- the public `index.html` is reachable
- local bundle references use the expected base path for that environment
- the referenced JS/CSS assets return `200`

Infra deploys now build Lambda Python dependencies from `backend/requirements.txt` inside Docker during CDK asset bundling. This means:

- Docker must be running before `npm run deploy:infra:*`
- clean checkouts deploy correctly without local vendored Python folders under `backend/`
- Lambda package contents are driven by tracked backend source plus `requirements.txt`, not untracked local artifacts

## Local Frontend Commands

Use local frontend development for most branch testing. This keeps day-to-day UI iteration off the shared dev URL while still using the selected environment's API, Cognito, and shared storage.

Default local workflow against the current dev environment:

```bash
npm run local:frontend:dev
```

Optional local targets:

```bash
npm run local:frontend:prod
npm run local:frontend:shared
```

If you only want to write `frontend/.env.local` and start Vite yourself later:

```bash
npm run setup:frontend:local:dev
```

Important points:

- the local runner uses `http://localhost:5173/` because that callback is already allowed in Cognito
- if you want another localhost port or callback path, add it to the Cognito app client first
- `frontend/.env.local` is gitignored and can be safely rewritten per environment
- shared dev should be deployed from reviewed `main`, not from routine feature branches

## Migration Tools

### Clone one prod task into dev

```bash
python3 scripts/clone_prod_task_to_dev.py --task-id TASK_ID --target-email YOUR_LOGIN_EMAIL
```

### Migrate a user between environments

```bash
python3 scripts/migrate_user_data.py \
  --source-email USER@example.com \
  --target-email USER@example.com \
  --source-outputs infra/cdk-outputs.shared.json \
  --target-outputs infra/cdk-outputs.dev.json \
  --source-label shared \
  --target-label dev \
  --dry-run
```

Important points:

- data migration is by Cognito `sub`
- source data is copied, not deleted
- task ids are preserved by default
- API request/upload data can be migrated alongside task data

## Operational Notes

- Sign out and sign back in after Cognito group changes so the refreshed token includes updated `cognito:groups` claims.
- New prod users created via Cognito admin flows may start in `FORCE_CHANGE_PASSWORD` state.
- Use the manual smoke checklist after deploys or major refactors.
- Collaborators should not deploy shared dev or prod directly; merge and deploy remain owner-controlled from `main`.

## Related Docs

- [Manual Smoke Checklist](./manual-smoke-checklist.md)
- [Collaboration and Release](./collaboration-and-release.md)
- [Production Subdomain Cutover](./subdomain-prod-cutover.md)
