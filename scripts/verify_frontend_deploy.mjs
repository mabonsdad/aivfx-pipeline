import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const target = process.argv[2];

if (target !== "dev" && target !== "prod") {
  console.error("Usage: node scripts/verify_frontend_deploy.mjs <dev|prod>");
  process.exit(1);
}

const config =
  target === "prod"
    ? {
        outputsPath: process.env.PROD_OUTPUTS_FILE || resolve(repoRoot, "infra", "cdk-outputs.prod.json"),
        stackName: process.env.AIVFX_PROD_STACK_NAME || "AivfxProdStack",
        expectedBasePath: "/",
      }
    : {
        outputsPath: process.env.DEV_OUTPUTS_FILE || resolve(repoRoot, "infra", "cdk-outputs.dev.json"),
        stackName: process.env.AIVFX_DEV_STACK_NAME || "AivfxDevStack",
        expectedBasePath: process.env.DEV_WEB_BASE_PATH || "/experiments/aivfx/",
      };

function loadStackOutputs(path, expectedStackName) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw[expectedStackName]) return raw[expectedStackName];
  const [firstValue] = Object.values(raw);
  return firstValue ?? {};
}

function normalizePublicUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    throw new Error(`Missing WebUrl in ${config.outputsPath}`);
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function buildPageUrls(baseUrl) {
  const indexUrl = new URL(baseUrl);
  const apiTestUrl = new URL("api-test.html", baseUrl);
  return [
    { label: "index", url: indexUrl },
    { label: "api-test", url: apiTestUrl },
  ];
}

function extractLocalRefs(html) {
  const matches = [...html.matchAll(/(?:src|href)="([^"]+)"/g)];
  return matches
    .map((match) => match[1])
    .filter((value) => value && !value.startsWith("http://") && !value.startsWith("https://") && !value.startsWith("//"));
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  const text = await response.text();
  return { response, text };
}

async function verifyAsset(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  if (!response.ok) {
    throw new Error(`Asset ${url} returned ${response.status}`);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const outputs = loadStackOutputs(config.outputsPath, config.stackName);
const publicUrl = normalizePublicUrl(outputs.WebUrl);
const attempts = Number(process.env.FRONTEND_VERIFY_ATTEMPTS || 18);
const delayMs = Number(process.env.FRONTEND_VERIFY_DELAY_MS || 5000);

let lastError = "Unknown verification error";

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const pageUrls = buildPageUrls(publicUrl);

    for (const { label, url } of pageUrls) {
      url.searchParams.set("__verify", `${Date.now()}-${attempt}-${label}`);
      const { response, text } = await fetchText(url.toString());
      if (!response.ok) {
        throw new Error(`${label} page returned ${response.status}`);
      }
      if (!text.includes('<div id="root"></div>')) {
        throw new Error(`Root mount element missing from ${label}.html`);
      }

      const localRefs = extractLocalRefs(text);
      const assetRefs = localRefs.filter((ref) => ref.includes("/assets/"));
      if (!assetRefs.length) {
        throw new Error(`No local asset references found in ${label}.html`);
      }

      const invalidRefs = assetRefs.filter(
        (ref) => config.expectedBasePath !== "/" && !ref.startsWith(config.expectedBasePath),
      );
      if (invalidRefs.length) {
        throw new Error(
          `${label}.html asset refs missing expected base path ${config.expectedBasePath}: ${invalidRefs.join(", ")}`,
        );
      }

      for (const ref of assetRefs) {
        await verifyAsset(new URL(ref, publicUrl).toString());
      }
    }

    console.log(
      `Verified ${target} frontend at ${publicUrl} for index and api-test using base path ${config.expectedBasePath}`,
    );
    process.exit(0);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }
}

console.error(`Frontend verification failed for ${target}: ${lastError}`);
process.exit(1);
