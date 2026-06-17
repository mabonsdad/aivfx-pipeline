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
