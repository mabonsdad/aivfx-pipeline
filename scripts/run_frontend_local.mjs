import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const target = process.argv[2] || "dev";
const envOnly = process.argv.includes("--env-only");

if (!["dev", "prod", "shared"].includes(target)) {
  console.error("Usage: node scripts/run_frontend_local.mjs <dev|prod|shared> [--env-only]");
  process.exit(1);
}

const configByTarget = {
  dev: {
    outputsPath: resolve(repoRoot, "infra", "cdk-outputs.dev.json"),
    stackName: "AivfxDevStack",
    label: "dev",
  },
  prod: {
    outputsPath: resolve(repoRoot, "infra", "cdk-outputs.prod.json"),
    stackName: "AivfxProdStack",
    label: "prod",
  },
  shared: {
    outputsPath: resolve(repoRoot, "infra", "cdk-outputs.shared.json"),
    stackName: "AivfxStack",
    label: "shared",
  },
};

const targetConfig = configByTarget[target];

function loadStackOutputs(path, expectedStackName) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw[expectedStackName]) return raw[expectedStackName];
  const [firstValue] = Object.values(raw);
  return firstValue ?? {};
}

const outputs = loadStackOutputs(targetConfig.outputsPath, targetConfig.stackName);
const requiredKeys = ["ApiUrl", "CognitoUserPoolId", "CognitoUserPoolClientId", "CognitoDomain"];
const missing = requiredKeys.filter((key) => !outputs[key]);

if (missing.length) {
  console.error(`Missing required outputs in ${targetConfig.outputsPath}: ${missing.join(", ")}`);
  process.exit(1);
}

const localEnvPath = resolve(repoRoot, "frontend", ".env.local");
const localEnv = [
  `VITE_API_BASE_URL=${outputs.ApiUrl}`,
  `VITE_COGNITO_USER_POOL_ID=${outputs.CognitoUserPoolId}`,
  `VITE_COGNITO_USER_POOL_CLIENT_ID=${outputs.CognitoUserPoolClientId}`,
  `VITE_COGNITO_DOMAIN=${outputs.CognitoDomain}`,
  "VITE_COGNITO_REDIRECT_SIGN_IN=http://localhost:5173/",
  "VITE_COGNITO_REDIRECT_SIGN_OUT=http://localhost:5173/",
  "VITE_COGNITO_REGION=eu-west-2",
  "VITE_BASE_PATH=/",
].join("\n");

writeFileSync(localEnvPath, `${localEnv}\n`, "utf8");

console.log(`Wrote frontend/.env.local for ${targetConfig.label}`);
console.log(`API: ${outputs.ApiUrl}`);
console.log(`User pool: ${outputs.CognitoUserPoolId}`);
console.log(`Client: ${outputs.CognitoUserPoolClientId}`);
console.log(`Hosted UI: ${outputs.CognitoDomain}`);
console.log("Local app URL: http://localhost:5173/");

if (envOnly) {
  process.exit(0);
}

execSync("npm run dev -- --host 127.0.0.1 --port 5173", {
  cwd: resolve(repoRoot, "frontend"),
  stdio: "inherit",
  env: process.env,
});
