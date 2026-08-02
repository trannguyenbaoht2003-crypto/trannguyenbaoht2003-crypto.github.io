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
