# AIVFX Production Subdomain Cutover

This document covers the current prod/dev split:

- Production frontend: `https://aivfx.shwsh.co.uk/`
- Development frontend: `https://www.shwsh.co.uk/experiments/aivfx/`

The repo now supports:

- a shared legacy stack that still backs the path-hosted dev app
- an isolated production stack for the `aivfx.shwsh.co.uk` subdomain
- an optional isolated development stack for future use
- separate frontend builds generated from each stack's outputs

## What this phase changes

- The current path-hosted build remains the development frontend.
- A separate production frontend build is prepared for the root of `aivfx.shwsh.co.uk`.
- The CDK deploy flow now supports a shared stack, a dedicated prod stack, and a separate dev stack.
- The prod stack can create and own a dedicated CloudFront distribution for AIVFX with:
  - custom aliases
  - ACM certificate ARN
  - root-hosted SPA routing

Current stack roles:

- `AivfxStack`: shared legacy data/API/auth stack used by `https://www.shwsh.co.uk/experiments/aivfx/`
- `AivfxProdStack`: clean production stack used by `https://aivfx.shwsh.co.uk/`
- `AivfxDevStack`: optional isolated dev stack if we later want dev separated from the shared historical dataset

## Prerequisites

You need AWS access that can do all of the following:

- ACM in `us-east-1`
- CloudFront distribution deploy/update
- Route53 record changes for `shwsh.co.uk`

If Route53 is not in AWS, use the equivalent DNS UI at your provider and create the same validation and alias/CNAME records.

## Set the CLI region first

The AIVFX stack is in `eu-west-2`. Set the AWS CLI default there before running AIVFX deploys:

```bash
aws configure set region eu-west-2
```

If you use a named profile:

```bash
aws configure set region eu-west-2 --profile YOUR_PROFILE
```

Confirm with:

```bash
aws configure get region
```

## 1. Request or create the ACM certificate

CloudFront custom-domain certificates must live in `us-east-1`.

In ACM, region `us-east-1`:

1. Open AWS Certificate Manager.
2. Choose `Request certificate`.
3. Request a public certificate.
4. Add this domain name:
   - `aivfx.shwsh.co.uk`
5. Use `DNS validation`.
6. Complete the request.

If ACM gives you a DNS validation record, create it exactly as shown in the DNS zone for `shwsh.co.uk`.

Wait until the certificate status becomes `Issued`.

Record the certificate ARN. You will need it in the deploy environment:

```bash
APP_CLOUDFRONT_CERT_ARN=arn:aws:acm:us-east-1:...
```

## 2. Deploy the production stack

Set these environment variables before CDK deploy:

```bash
export MANAGE_APP_CLOUDFRONT=true
export APP_CLOUDFRONT_ALIASES=aivfx.shwsh.co.uk
export APP_CLOUDFRONT_CERT_ARN=arn:aws:acm:us-east-1:REPLACE_ME
export WEB_PUBLIC_BASE_URL=https://aivfx.shwsh.co.uk
export ALLOWED_WEB_ORIGINS=https://aivfx.shwsh.co.uk,https://www.shwsh.co.uk,https://shwsh.co.uk,https://s3.eu-west-2.amazonaws.com
export COGNITO_REDIRECT_SIGN_IN_URLS=https://aivfx.shwsh.co.uk/,https://aivfx.shwsh.co.uk/api-test.html,https://www.shwsh.co.uk/experiments/aivfx/,https://www.shwsh.co.uk/experiments/aivfx/api-test.html,https://shwsh.co.uk/experiments/aivfx/,https://shwsh.co.uk/experiments/aivfx/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html
export COGNITO_REDIRECT_SIGN_OUT_URLS=https://aivfx.shwsh.co.uk/,https://aivfx.shwsh.co.uk/api-test.html,https://www.shwsh.co.uk/experiments/aivfx/,https://www.shwsh.co.uk/experiments/aivfx/api-test.html,https://shwsh.co.uk/experiments/aivfx/,https://shwsh.co.uk/experiments/aivfx/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html
```

Then deploy:

```bash
npm run deploy:infra:prod
```

After deploy, note these outputs:

- `WebBucketName`
- `CloudFrontDistributionId`
- `CloudFrontDistributionDomainName`
- `CloudFrontAliases`

The outputs are written to:

```bash
infra/cdk-outputs.prod.json
```

## 3. Update the shared development stack

The live development app currently uses the long-lived shared stack, not the isolated dev stack.
That keeps existing historical task data available at the existing path-hosted URL.

Deploy it with:

```bash
npm run deploy:infra:shared
```

The outputs are written to:

```bash
infra/cdk-outputs.shared.json
```

If you explicitly want a separate dev backend/auth/storage stack for temporary testing, deploy:

```bash
npm run deploy:infra:dev
```

Those outputs are written to:

```bash
infra/cdk-outputs.dev.json
```

## 4. Create the Route53 alias record

In the Route53 hosted zone for `shwsh.co.uk`:

1. Create record
2. Record name:
   - `aivfx`
3. Record type:
   - `A`
4. Enable `Alias`
5. Alias target:
   - the new AIVFX CloudFront distribution
6. Save

Repeat for:

- `AAAA` alias record

If your DNS provider is not Route53:

- create `aivfx.shwsh.co.uk`
- point it at the CloudFront distribution domain name
- follow the provider’s CloudFront/custom-domain guidance

## 5. Build and upload the production frontend

The production frontend is now a root-hosted build.

Build it:

```bash
npm run build:frontend:prod
```

Upload it to the AIVFX web bucket from the CDK output:

```bash
aws s3 sync frontend/dist s3://REPLACE_WITH_AIVFX_WEB_BUCKET/ --delete
```

Invalidate the dedicated AIVFX CloudFront distribution:

```bash
aws cloudfront create-invalidation --distribution-id REPLACE_WITH_AIVFX_DISTRIBUTION_ID --paths "/*"
```

Or use the helper from repo root:

```bash
npm run deploy:frontend:prod
```

## 6. Keep the current path-hosted app as dev

The default frontend build remains the path-hosted dev build.

Build dev:

```bash
npm run build:frontend
```

Deploy dev as before:

```bash
aws s3 sync frontend/dist s3://shwsh.co.uk/experiments/aivfx/ --delete
aws cloudfront create-invalidation --distribution-id E3LS87IBDVMSCO --paths "/experiments/aivfx/*"
```

Or use the helper from repo root:

```bash
npm run deploy:frontend:dev
```

`deploy:frontend:dev` currently publishes the frontend to `www.shwsh.co.uk/experiments/aivfx/` while reading API/auth config from the shared stack outputs so dev continues to use the historical shared dataset.

## 7. Smoke checks after cutover

Check all of these on production:

1. `https://aivfx.shwsh.co.uk/` loads directly
2. hard refresh on a nested hash route works
3. Cognito login redirect returns to `aivfx.shwsh.co.uk`
4. logout redirect returns to `aivfx.shwsh.co.uk`
5. image/video previews still load
6. API requests succeed
7. S3 signed asset requests succeed

Then check dev still works:

1. `https://www.shwsh.co.uk/experiments/aivfx/`
2. existing login/logout behavior
3. existing CloudFront path invalidation behavior

## Current result

After deploying the shared and prod stacks:

- production frontend points at isolated production API/auth/storage
- development frontend remains on the shared historical API/auth/storage
- Cognito, assets, metadata, queues, and secrets are separated between prod and shared

At the time of writing:

- prod starts clean with no migrated task data
- dev keeps the existing shared test/development data
- prod provider credentials are copied from the shared secret initially and can now diverge independently

The next phase after this is data migration and operational cleanup:

- decide whether old shared task data remains the dev baseline
- migrate any wanted production seed data
- tighten prod-vs-dev secret values and provider quotas
