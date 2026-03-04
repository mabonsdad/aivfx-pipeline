# AI-assisted VFX Micro-Pipeline

Production-oriented implementation of a static-hosted React app with an AWS serverless backend for frame-accurate VFX experimentation.

## Repository layout

- `frontend/` React + TypeScript + Vite + Tailwind + TanStack Query + Zustand
- `backend/` Python 3.10 Lambda API + worker (SQS async jobs, ffmpeg/Gemini/Luma integrations)
- `infra/` AWS CDK (TypeScript) for S3, CloudFront, Cognito, API Gateway HTTP API, Lambda, SQS, IAM, Secrets Manager
- `.github/workflows/` PR CI and main-branch OIDC deploy workflows

## Implemented capabilities

- Cognito auth with JWT-secured API Gateway routes
- Task lifecycle with user-scoped metadata in S3 JSON snapshots
- Private S3 assets with short-lived pre-signed URLs only
- Video upload + async ingest job (`ffprobe`, VFR detection, CFR edit-source generation, thumbnail manifest)
- Timeline frame stepping with frame-accurate segment creation (5/6/10 seconds)
- Deterministic frame capture deduplication by frame UID
- Gemini image edits:
  - Full-frame edit (`gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`)
  - Patch-based edit with bleed + feather + optional mask compositing
- Luma Modify Video generation (create + poll + download result into private S3)
- Merge generated segments back into full timeline with optional temporal feathering (duration unchanged)
- Async job status polling via `/jobs/{jobId}`
- Audit logging with request/task/user IDs and hashed prompts (no raw prompt logging)

## Local development

### Prerequisites

- Node.js 20+
- Python 3.10+
- AWS CDK v2
- AWS credentials for target account

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m py_compile $(find src -name '*.py')
```

### Frontend

```bash
cd frontend
cp .env.example .env
npm ci
npm run dev
```

Populate `frontend/.env` with deployed API/Cognito values.

### Infra

```bash
cd infra
npm ci
npm run build
npx cdk synth
```

## Deployment

### GitHub Actions (recommended)

`deploy-main.yml` uses AWS OIDC (`secrets.AWS_OIDC_DEPLOY_ROLE_ARN`) and performs:

1. Lambda dependency packaging (`pip install -t backend`)
2. CDK deploy (`AivfxStack`)
3. Frontend build using stack outputs
4. Upload frontend to S3 (`experiments/aivfx/` prefix)
5. CloudFront invalidation

Set repository variables:

- `FFMPEG_LAYER_ARN`
- `REQUESTS_LAYER_ARN`
- `LUMALABS_LAYER_ARN`
- `WEB_BUCKET_OVERRIDE` (set to existing bucket such as `shwsh.co.uk`)
- `WEB_CLOUDFRONT_DISTRIBUTION_ID` (optional; existing distribution to invalidate for `/experiments/aivfx/*`)

By default, deployment does **not** create or manage an app CloudFront distribution (`MANAGE_APP_CLOUDFRONT=false` in workflow), so existing cert/domain setup for `shwsh.co.uk` and `www.shwsh.co.uk` is not modified by this stack.

### Manual deploy

```bash
# 1) package backend dependencies
pip install -r backend/requirements.txt -t backend

# 2) deploy infra
cd infra
npm ci
npm run build
npx cdk deploy AivfxStack --require-approval never --outputs-file cdk-outputs.json

# 3) build frontend with outputs
cd ../frontend
npm ci
# create .env.production from cdk-outputs.json values
npm run build

# 4) sync frontend
aws s3 sync dist s3://<web-bucket>/experiments/aivfx/ --delete
```

## Configuration

### Backend env vars

See `backend/.env.example`.

Required at runtime:

- `ASSETS_BUCKET`
- `METADATA_BUCKET`
- `JOBS_QUEUE_URL`
- `SECRETS_ARN`
- `CORS_ALLOWED_ORIGINS`

`SECRETS_ARN` secret JSON schema:

```json
{
  "GEMINI_API_KEY": "...",
  "LUMA_API_KEY": "...",
  "RUNWAY_API_KEY": "...",
  "KLING_API_KEY": "...",
  "RUNWARE_API_KEY": "..."
}
```

### Frontend env vars

See `frontend/.env.example`.

Required:

- `VITE_API_BASE_URL`
- `VITE_COGNITO_USER_POOL_ID`
- `VITE_COGNITO_USER_POOL_CLIENT_ID`
- `VITE_COGNITO_DOMAIN`
- redirect URIs

## Known limits

- Freehand brush masking is not implemented yet (rect + optional uploaded mask is implemented).
- Frame-strip endpoint currently extracts thumbnails synchronously for short ranges (<= 6s).
- Multi-segment merge is supported sequentially, but UX currently exposes a simple selection UI.
- Kling 2.6 start/end-frame generation currently maps requested segment duration to nearest supported duration (5s or 10s).
- Prompt text is stored in segment-generation metadata for reproducibility; logs contain only prompt hashes/length.

## Demo seed video instructions

Do not commit media to the repository. To run a demo:

1. Create a task in the UI.
2. Upload a local short MP4 sample (5-30 seconds recommended).
3. Run ingest and proceed through timeline/frame edit/generate/merge tabs.

## Future extensions

- Last-frame constrained generation for additional models.
- Two-keyframe control models (start + end frame guidance).
- Style-transfer models that accept both first and last frame conditions.
- Richer masking tools (interactive brush/lasso, edge-aware matte refinement).
