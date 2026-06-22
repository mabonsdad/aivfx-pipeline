import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const target = process.argv[2];

if (target !== "dev" && target !== "prod") {
  console.error("Usage: node scripts/deploy_frontend.mjs <dev|prod>");
  process.exit(1);
}

const region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || "eu-west-2";
const sharedEnv = {
  ...process.env,
  AWS_DEFAULT_REGION: region,
  AWS_REGION: region,
};

const loadStackOutputs = (path, fallbackStackName) => {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (fallbackStackName && data[fallbackStackName]) {
    return data[fallbackStackName];
  }
  const [firstValue] = Object.values(data);
  return firstValue ?? {};
};

const config =
  target === "prod"
    ? {
        buildScript: "build:frontend:prod",
        mode: "production",
        outputsPath: process.env.PROD_OUTPUTS_FILE || resolve(repoRoot, "infra", "cdk-outputs.prod.json"),
        configOutputsPath: process.env.PROD_CONFIG_OUTPUTS_FILE || process.env.PROD_OUTPUTS_FILE || resolve(repoRoot, "infra", "cdk-outputs.prod.json"),
        stackName: process.env.AIVFX_PROD_STACK_NAME || "AivfxProdStack",
        invalidatePath: "/*",
      }
    : {
        buildScript: "build:frontend:dev",
        mode: "devhosted",
        outputsPath: process.env.DEV_OUTPUTS_FILE || resolve(repoRoot, "infra", "cdk-outputs.dev.json"),
        configOutputsPath: process.env.DEV_CONFIG_OUTPUTS_FILE || process.env.DEV_OUTPUTS_FILE || resolve(repoRoot, "infra", "cdk-outputs.dev.json"),
        stackName: process.env.AIVFX_DEV_STACK_NAME || "AivfxDevStack",
        invalidatePath: process.env.DEV_CLOUDFRONT_INVALIDATION_PATH || "/experiments/aivfx/*",
        syncPrefix: process.env.DEV_WEB_PREFIX || "experiments/aivfx/",
      };

const stackOutputs = loadStackOutputs(config.outputsPath, config.stackName);
const configStackOutputs = loadStackOutputs(config.configOutputsPath, config.stackName);
const bucket =
  (target === "prod" ? process.env.PROD_WEB_BUCKET : process.env.DEV_WEB_BUCKET) || stackOutputs.WebBucketName;
const distributionId =
  (target === "prod" ? process.env.PROD_CLOUDFRONT_DISTRIBUTION_ID : process.env.DEV_CLOUDFRONT_DISTRIBUTION_ID) ||
  stackOutputs.CloudFrontDistributionId ||
  (target === "dev" ? "E3LS87IBDVMSCO" : "");

if (!bucket || !distributionId) {
  console.error(`Missing deploy configuration for ${target}. Check ${config.outputsPath}.`);
  process.exit(1);
}

const localEnvPath = resolve(repoRoot, "frontend", `.env.${config.mode}.local`);
const localEnv = [
  `VITE_API_BASE_URL=${configStackOutputs.ApiUrl || ""}`,
  `VITE_COGNITO_USER_POOL_ID=${configStackOutputs.CognitoUserPoolId || ""}`,
  `VITE_COGNITO_USER_POOL_CLIENT_ID=${configStackOutputs.CognitoUserPoolClientId || ""}`,
  `VITE_COGNITO_DOMAIN=${configStackOutputs.CognitoDomain || ""}`,
  `VITE_COGNITO_REDIRECT_SIGN_IN=${target === "prod" ? "https://aivfx.shwsh.co.uk/" : "https://www.shwsh.co.uk/experiments/aivfx/"}`,
  `VITE_COGNITO_REDIRECT_SIGN_OUT=${target === "prod" ? "https://aivfx.shwsh.co.uk/" : "https://www.shwsh.co.uk/experiments/aivfx/"}`,
  "VITE_COGNITO_REGION=eu-west-2",
  `VITE_BASE_PATH=${target === "prod" ? "/" : "/experiments/aivfx/"}`,
].join("\n");

writeFileSync(localEnvPath, `${localEnv}\n`, "utf8");

const destination =
  target === "prod" ? `s3://${bucket}/` : `s3://${bucket}/${config.syncPrefix}`;
const htmlDestination =
  target === "prod" ? `s3://${bucket}` : `s3://${bucket}/${config.syncPrefix.replace(/\/$/, "")}`;
const expectedBasePath = target === "prod" ? "/" : "/experiments/aivfx/";

const run = (command) => {
  execSync(command, {
    cwd: repoRoot,
    env: sharedEnv,
    stdio: "inherit",
  });
};

const extractLocalRefs = (html) => {
  const matches = [...html.matchAll(/(?:src|href)="([^"]+)"/g)];
  return matches
    .map((match) => match[1])
    .filter((value) => value && !value.startsWith("http://") && !value.startsWith("https://") && !value.startsWith("//"));
};

const verifyBuiltHtml = (filename) => {
  const htmlPath = resolve(repoRoot, "frontend", "dist", filename);
  const html = readFileSync(htmlPath, "utf8");
  if (!html.includes('<div id="root"></div>')) {
    throw new Error(`${filename} is missing the root mount element`);
  }
  const assetRefs = extractLocalRefs(html).filter((ref) => ref.includes("/assets/"));
  if (!assetRefs.length) {
    throw new Error(`${filename} has no local asset references`);
  }
  if (expectedBasePath !== "/") {
    const invalidRefs = assetRefs.filter((ref) => !ref.startsWith(expectedBasePath));
    if (invalidRefs.length) {
      throw new Error(
        `${filename} asset refs are missing expected base path ${expectedBasePath}: ${invalidRefs.join(", ")}`,
      );
    }
  }
};

run(`npm run ${config.buildScript}`);
verifyBuiltHtml("index.html");
verifyBuiltHtml("api-test.html");
run(`aws s3 sync frontend/dist ${destination} --delete --exclude index.html --exclude api-test.html`);
run(`aws s3 cp frontend/dist/index.html ${htmlDestination}/index.html`);
run(`aws s3 cp frontend/dist/api-test.html ${htmlDestination}/api-test.html`);
run(`aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "${config.invalidatePath}"`);
run(`node scripts/verify_frontend_deploy.mjs ${target}`);
