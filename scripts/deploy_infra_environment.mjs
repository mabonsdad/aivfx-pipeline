import { execSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const infraDir = resolve(repoRoot, "infra");
const target = process.argv[2];

if (target !== "prod" && target !== "dev" && target !== "shared") {
  console.error("Usage: node scripts/deploy_infra_environment.mjs <shared|prod|dev>");
  process.exit(1);
}

const region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || "eu-west-2";
const isProd = target === "prod";
const isShared = target === "shared";

const targetConfig = isShared
  ? {
      stackName: process.env.AIVFX_SHARED_STACK_NAME || "AivfxStack",
      stackDescription: "AI-assisted VFX micro-pipeline shared development stack",
      appName: process.env.AIVFX_SHARED_APP_NAME || "aivfx",
      outputsFile: resolve(infraDir, "cdk-outputs.shared.json"),
      cdkOutDir: "cdk.out.shared",
      extraEnv: {
        MANAGE_APP_CLOUDFRONT: "false",
        WEB_PUBLIC_BASE_URL: process.env.WEB_PUBLIC_BASE_URL || "https://www.shwsh.co.uk/experiments/aivfx/",
        ALLOWED_WEB_ORIGINS:
          process.env.ALLOWED_WEB_ORIGINS ||
          "https://www.shwsh.co.uk,https://shwsh.co.uk,http://localhost:5173,https://aivfx.shwsh.co.uk",
        COGNITO_REDIRECT_SIGN_IN_URLS:
          process.env.COGNITO_REDIRECT_SIGN_IN_URLS ||
          "https://www.shwsh.co.uk/experiments/aivfx/,https://www.shwsh.co.uk/experiments/aivfx/api-test.html,https://shwsh.co.uk/experiments/aivfx/,https://shwsh.co.uk/experiments/aivfx/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html",
        COGNITO_REDIRECT_SIGN_OUT_URLS:
          process.env.COGNITO_REDIRECT_SIGN_OUT_URLS ||
          "https://www.shwsh.co.uk/experiments/aivfx/,https://www.shwsh.co.uk/experiments/aivfx/api-test.html,https://shwsh.co.uk/experiments/aivfx/,https://shwsh.co.uk/experiments/aivfx/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html",
      },
    }
  : isProd
  ? {
      stackName: process.env.AIVFX_PROD_STACK_NAME || "AivfxProdStack",
      stackDescription: "AI-assisted VFX micro-pipeline production stack",
      appName: process.env.AIVFX_PROD_APP_NAME || "aivfx-prod",
      outputsFile: resolve(infraDir, "cdk-outputs.prod.json"),
      cdkOutDir: "cdk.out.prod",
      extraEnv: {
        MANAGE_APP_CLOUDFRONT: process.env.MANAGE_APP_CLOUDFRONT || "true",
        APP_CLOUDFRONT_ALIASES: process.env.APP_CLOUDFRONT_ALIASES || "aivfx.shwsh.co.uk",
        APP_CLOUDFRONT_CERT_ARN:
          process.env.APP_CLOUDFRONT_CERT_ARN ||
          "arn:aws:acm:us-east-1:528323923790:certificate/4132eb25-b6df-40e2-b287-a2f5318632c5",
        WEB_PUBLIC_BASE_URL: process.env.WEB_PUBLIC_BASE_URL || "https://aivfx.shwsh.co.uk",
        ALLOWED_WEB_ORIGINS:
          process.env.ALLOWED_WEB_ORIGINS ||
          "https://aivfx.shwsh.co.uk,https://www.shwsh.co.uk,https://shwsh.co.uk,https://s3.eu-west-2.amazonaws.com",
        COGNITO_REDIRECT_SIGN_IN_URLS:
          process.env.COGNITO_REDIRECT_SIGN_IN_URLS ||
          "https://aivfx.shwsh.co.uk/,https://aivfx.shwsh.co.uk/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html",
        COGNITO_REDIRECT_SIGN_OUT_URLS:
          process.env.COGNITO_REDIRECT_SIGN_OUT_URLS ||
          "https://aivfx.shwsh.co.uk/,https://aivfx.shwsh.co.uk/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html",
      },
    }
  : {
      stackName: process.env.AIVFX_DEV_STACK_NAME || "AivfxDevStack",
      stackDescription: "AI-assisted VFX micro-pipeline development stack",
      appName: process.env.AIVFX_DEV_APP_NAME || "aivfx-dev",
      outputsFile: resolve(infraDir, "cdk-outputs.dev.json"),
      cdkOutDir: "cdk.out.dev",
      extraEnv: {
        MANAGE_APP_CLOUDFRONT: "false",
        WEB_BUCKET_OVERRIDE: process.env.WEB_BUCKET_OVERRIDE || "shwsh.co.uk",
        WEB_PUBLIC_BASE_URL: process.env.WEB_PUBLIC_BASE_URL || "https://www.shwsh.co.uk/experiments/aivfx/",
        ALLOWED_WEB_ORIGINS:
          process.env.ALLOWED_WEB_ORIGINS ||
          "https://www.shwsh.co.uk,https://shwsh.co.uk,http://localhost:5173,https://aivfx.shwsh.co.uk",
        COGNITO_REDIRECT_SIGN_IN_URLS:
          process.env.COGNITO_REDIRECT_SIGN_IN_URLS ||
          "https://www.shwsh.co.uk/experiments/aivfx/,https://www.shwsh.co.uk/experiments/aivfx/api-test.html,https://shwsh.co.uk/experiments/aivfx/,https://shwsh.co.uk/experiments/aivfx/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html",
        COGNITO_REDIRECT_SIGN_OUT_URLS:
          process.env.COGNITO_REDIRECT_SIGN_OUT_URLS ||
          "https://www.shwsh.co.uk/experiments/aivfx/,https://www.shwsh.co.uk/experiments/aivfx/api-test.html,https://shwsh.co.uk/experiments/aivfx/,https://shwsh.co.uk/experiments/aivfx/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html",
      },
    };

const env = {
  ...process.env,
  AWS_DEFAULT_REGION: region,
  AWS_REGION: region,
  AIVFX_CDK_REGION: region,
  AIVFX_STACK_NAME: targetConfig.stackName,
  AIVFX_STACK_DESCRIPTION: targetConfig.stackDescription,
  APP_NAME: targetConfig.appName,
  ...targetConfig.extraEnv,
};

const run = (command) => {
  execSync(command, {
    cwd: infraDir,
    env,
    stdio: "inherit",
  });
};

run("npm run build");
run(
  `npx cdk deploy ${targetConfig.stackName} --require-approval never --outputs-file ${targetConfig.outputsFile} --output ${targetConfig.cdkOutDir}`,
);
