import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

test("staging topology is same-origin, private by default, and deployment-free", async () => {
  const [compose, caddy, frontendDockerfile, exampleEnv, dockerignore] = await Promise.all([
    read("deploy/staging/compose.yml"),
    read("deploy/staging/Caddyfile"),
    read("deploy/staging/Dockerfile.frontend"),
    read("deploy/staging/.env.example"),
    read(".dockerignore"),
  ]);

  assert.match(compose, /\n  postgres:\n\s+image: postgres:17/);
  assert.match(compose, /\n  redis:\n\s+image: redis:7/);
  assert.match(compose, /\n  migrate:/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(compose, /\n  backend:/);
  assert.match(compose, /\n  gateway:/);
  assert.match(compose, /ports:\n\s+- "\$\{STAGING_PORT:-8080\}:80"/);
  assert.equal((compose.match(/\n\s+ports:/g) ?? []).length, 1);
  assert.doesNotMatch(compose, /5432:5432|6379:6379|3001:3001/);
  assert.doesNotMatch(compose, /\n  worker:/);

  const gatewayBlock = compose.match(/\n  gateway:\n[\s\S]*?(?=\nvolumes:)/)?.[0];
  assert.ok(gatewayBlock, "gateway service block is missing");
  assert.doesNotMatch(
    gatewayBlock,
    /depends_on:/,
    "gateway must start independently so static files remain available during backend startup failure",
  );

  assert.match(caddy, /handle \/api\/v1\/\*/);
  assert.match(caddy, /handle \/health\/\*/);
  assert.match(caddy, /reverse_proxy backend:3001/);
  assert.match(caddy, /try_files \{path\} \{path\}\/ \/index\.html/);
  assert.match(caddy, /Cache-Control "no-store"/);

  assert.match(frontendDockerfile, /FROM node:22\.13\.0-bookworm-slim AS build/);
  assert.match(frontendDockerfile, /ARG NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin/);
  assert.match(frontendDockerfile, /ENV NEXT_PUBLIC_PUBLIC_API_BASE_URL=\$NEXT_PUBLIC_PUBLIC_API_BASE_URL/);
  assert.match(frontendDockerfile, /RUN npm run build:pages/);
  assert.match(frontendDockerfile, /FROM caddy:2-alpine/);

  assert.match(exampleEnv, /STAGING_PORT=8080/);
  assert.match(exampleEnv, /POSTGRES_DB=/);
  assert.match(exampleEnv, /POSTGRES_USER=/);
  assert.match(exampleEnv, /POSTGRES_PASSWORD=/);
  assert.doesNotMatch(exampleEnv, /https?:\/\/(?!127\.0\.0\.1|localhost)/);

  assert.match(dockerignore, /node_modules/);
  assert.match(dockerignore, /\.next/);
  assert.match(dockerignore, /out/);
  assert.match(dockerignore, /\.env/);

  const deploymentSource = [compose, caddy, frontendDockerfile, exampleEnv].join("\n");
  assert.doesNotMatch(deploymentSource, /access-control-allow-origin|cors/i);
  assert.doesNotMatch(deploymentSource, /docker\s+(?:login|push)|gh-pages|pages deploy|kubectl|terraform|pulumi|aws |gcloud|az login/i);
  assert.doesNotMatch(deploymentSource, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
});

test("staging smoke checks normal, outage, recovery, and the absent mutation route", async () => {
  const smoke = await read("scripts/staging-smoke.mjs");

  assert.match(smoke, /STAGING_BASE_URL/);
  assert.match(smoke, /"normal"/);
  assert.match(smoke, /"backend-down"/);
  assert.match(smoke, /"recovered"/);
  assert.match(smoke, /\/health\/live/);
  assert.match(smoke, /\/health\/ready/);
  assert.match(smoke, /\/api\/v1\/publications/);
  assert.match(smoke, /method:\s*"POST"/);
  assert.match(smoke, /404.*405|405.*404/s);
  assert.match(smoke, /Lõi\.Meta/);
  assert.doesNotMatch(smoke, /authorization|bearer|setInterval|setTimeout/i);
  assert.doesNotMatch(smoke, /retry|poll/i);
});

test("Sprint 5C documents and verifies staging without production deployment", async () => {
  const [runbook, workflow] = await Promise.all([
    read("docs/runbooks/staging-environment.md"),
    read(".github/workflows/sprint-5c-staging-integration.yml"),
  ]);

  for (const contract of [
    "same-origin",
    "PostgreSQL 17",
    "Redis 7",
    "migration",
    "backend outage",
    "application rollback",
    "forward-only",
    "No production deployment",
  ]) {
    assert.ok(runbook.includes(contract), `staging runbook is missing: ${contract}`);
  }

  assert.match(workflow, /^name: Sprint 5C staging integration gate$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /npm run test:staging-contract/);
  assert.match(workflow, /npm run staging:config/);
  assert.match(workflow, /npm run staging:up/);
  assert.match(workflow, /npm run staging:smoke -- normal/);
  assert.match(workflow, /stop backend/);
  assert.match(workflow, /npm run staging:smoke -- backend-down/);
  assert.match(workflow, /up -d --wait backend/);
  assert.match(workflow, /npm run staging:smoke -- recovered/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /npm run staging:down/);

  const executableWorkflow = workflow.split("- name: Deployment guard")[0];
  assert.doesNotMatch(workflow, /(contents|packages|pages|id-token):\s*write/);
  assert.doesNotMatch(executableWorkflow, /docker\s+(?:login|push)|git push|actions\/deploy-pages|wrangler\s+deploy/);
  assert.doesNotMatch(executableWorkflow, /kubectl|terraform|pulumi|aws |gcloud|az login/i);
  assert.doesNotMatch(workflow, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
});
