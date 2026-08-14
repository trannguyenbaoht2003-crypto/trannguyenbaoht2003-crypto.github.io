import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function exists(path) {
  try {
    await text(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("Sprint 6B adds private worker and cron collector runtime artifacts", async () => {
  for (const path of [
    "backend/railway.worker.toml",
    "deploy/production/Dockerfile.collector",
    "deploy/production/railway.collector.toml",
    "deploy/production/run-community-collector.sh",
  ]) {
    assert.equal(await exists(path), true, `${path} must exist`);
  }

  const worker = await text("backend/railway.worker.toml");
  assert.match(worker, /startCommand\s*=\s*"node dist\/src\/worker\.js"/);
  assert.doesNotMatch(worker, /healthcheckPath|PORT\s*=|public/i);

  const collector = await text("deploy/production/railway.collector.toml");
  assert.match(collector, /cronSchedule\s*=\s*"0 \*\/6 \* \* \*"/);
  assert.match(collector, /restartPolicyType\s*=\s*"NEVER"/);
  assert.doesNotMatch(collector, /healthcheckPath|public/i);
});

test("collector runtime runs discovery then governed backend import and exits", async () => {
  const script = await text("deploy/production/run-community-collector.sh");
  assert.match(script, /set -e/);
  const collectIndex = script.indexOf("collect-community-candidates.mjs");
  const importIndex = script.indexOf("community-import-cli.js");
  assert.ok(collectIndex >= 0, "collector command missing");
  assert.ok(importIndex > collectIndex, "governed import must run after discovery");
  assert.doesNotMatch(script, /publish|curl|Authorization|Bearer/i);

  const dockerfile = await text("deploy/production/Dockerfile.collector");
  assert.match(dockerfile, /USER node/);
  assert.doesNotMatch(dockerfile, /ENV\s+(DATABASE_URL|REDIS_URL|RAILWAY_TOKEN)=/);
});

test("production release gate requires and deploys private Sprint 6B services by exact tree", async () => {
  const workflow = await text(".github/workflows/production-release-gate.yml");
  for (const binding of ["RAILWAY_WORKER_SERVICE", "RAILWAY_COLLECTOR_SERVICE"]) {
    assert.ok(workflow.includes(binding), `workflow missing ${binding}`);
  }
  const backendIndex = workflow.indexOf('Deploy backend from exact tree');
  const workerIndex = workflow.indexOf('Deploy worker from exact tree');
  const collectorIndex = workflow.indexOf('Deploy collector from exact tree');
  const gatewayIndex = workflow.indexOf('Deploy gateway from exact tree');
  assert.ok(backendIndex >= 0 && workerIndex > backendIndex, "worker must deploy after backend");
  assert.ok(collectorIndex > workerIndex, "collector must deploy after worker");
  assert.ok(gatewayIndex > collectorIndex, "gateway must deploy after collector");
  assert.doesNotMatch(workflow, /railway\s+(init|add|link|new)|contents:\s*write|id-token:\s*write/);
});

test("backend bridge cannot translate legacy autoPublish into publication authority", async () => {
  const bridge = await text("backend/src/modules/community/community-inbox-bridge.ts");
  const importer = await text("backend/src/community-import-cli.ts");
  assert.doesNotMatch(bridge, /autoPublish|publishCandidate|PublicationPublished/);
  assert.doesNotMatch(importer, /autoPublish|publishCandidate|PublicationPublished|insert\s+into\s+publications/i);
  assert.match(importer, /ingestObservation/);
});

test("production runbook documents private services and no-auto-publish handoff", async () => {
  const runbook = await text("docs/runbooks/production-delivery.md");
  for (const token of [
    "community-collector-v1",
    "worker",
    "collector",
    "0 */6 * * *",
    "RAILWAY_WORKER_SERVICE",
    "RAILWAY_COLLECTOR_SERVICE",
    "SPRINT_6B_REPO_READY",
  ]) {
    assert.ok(runbook.includes(token), `runbook missing ${token}`);
  }
  assert.match(runbook, /autoPublish.*ignored|ignored.*autoPublish/i);
});