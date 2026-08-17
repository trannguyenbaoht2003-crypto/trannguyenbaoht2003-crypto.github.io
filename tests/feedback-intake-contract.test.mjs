import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const requiredFiles = [
  "docs/superpowers/specs/2026-08-17-feedback-intake-design.md",
  "docs/superpowers/plans/2026-08-17-feedback-intake.md",
  "docs/runbooks/public-feedback-intake.md",
  "backend/migrations/0013_publication_feedback_intake.sql",
  "backend/src/modules/feedback/types.ts",
  "backend/src/modules/feedback/normalize-feedback-input.ts",
  "backend/src/modules/feedback/feedback-fingerprint.ts",
  "backend/src/modules/feedback/feedback-rate-limiter.ts",
  "backend/src/modules/feedback/submit-publication-feedback.ts",
  "backend/src/modules/feedback/read-publication-feedback-signals.ts",
  "backend/src/http/public-feedback.ts",
  "app/public-data/feedback-client.ts",
  "app/PublicFeedbackPanel.tsx",
  ".github/workflows/sprint-7b-feedback-intake.yml",
];

const feedbackProductionFiles = [
  "backend/src/modules/feedback/types.ts",
  "backend/src/modules/feedback/normalize-feedback-input.ts",
  "backend/src/modules/feedback/feedback-fingerprint.ts",
  "backend/src/modules/feedback/feedback-rate-limiter.ts",
  "backend/src/modules/feedback/submit-publication-feedback.ts",
  "backend/src/modules/feedback/read-publication-feedback-signals.ts",
  "backend/src/http/public-feedback.ts",
  "app/public-data/feedback-client.ts",
  "app/PublicFeedbackPanel.tsx",
];

test("Sprint 7B artifact set is complete", async () => {
  for (const path of requiredFiles) {
    await assert.doesNotReject(access(new URL(path, root)), `missing ${path}`);
  }
});

test("anonymous feedback source cannot call trust, monitoring, or Publication mutation authority", async () => {
  const source = (await Promise.all(feedbackProductionFiles.map(read))).join("\n");
  for (const forbidden of [
    "publishCandidateRevision",
    "rollbackPublication",
    "recordClaimEvidenceDecision",
    "completeHumanReview",
    "recordCandidateModerationDecision",
    "evaluateCandidateEligibility",
    "evaluatePublicationMonitoring",
  ]) {
    assert.ok(!source.includes(forbidden), `feedback source references forbidden authority: ${forbidden}`);
  }

  const dispatcher = await read("backend/src/queue/outbox-dispatcher.ts");
  assert.ok(!dispatcher.includes("FeedbackSubmitted"));
  for (const path of [
    "backend/src/modules/publication/read-active-publications.ts",
    "backend/src/modules/publication/public-publication-reader.ts",
    "backend/src/queue/publication-projection-worker.ts",
  ]) {
    assert.ok(!(await read(path)).includes("publication_feedback_submissions"), `${path} couples public read to feedback`);
  }
});

test("feedback network identity and logs remain privacy bounded", async () => {
  const [route, app, server, productionCaddy, stagingCaddy] = await Promise.all([
    read("backend/src/http/public-feedback.ts"),
    read("backend/src/app.ts"),
    read("backend/src/server.ts"),
    read("deploy/production/Caddyfile"),
    read("deploy/staging/Caddyfile"),
  ]);

  for (const caddy of [productionCaddy, stagingCaddy]) {
    assert.match(caddy, /header_up X-Hai-Dau-Client-IP \{remote_host\}/);
    assert.doesNotMatch(caddy, /Access-Control-Allow-Origin/i);
  }

  assert.doesNotMatch(route, /x-forwarded-for|forwarded-for/i);
  assert.match(route, /x-hai-dau-client-ip/);
  assert.match(app, /req\.headers\.x-hai-dau-client-ip/);
  assert.match(app, /req\.(?:remoteAddress|ip)/);
  assert.doesNotMatch(route, /app\.log[^\n]*(?:details|fingerprint|gatewayIp)/i);
  assert.doesNotMatch(server, /console\.log|process\.stdout\.write/);
});

test("checked-in environments keep feedback disabled without a real fingerprint secret", async () => {
  for (const path of [
    "deploy/production/production.env.example",
    "deploy/staging/.env.example",
  ]) {
    const env = await read(path);
    assert.match(env, /^FEEDBACK_INTAKE_ENABLED=false$/m);
    assert.doesNotMatch(env, /^FEEDBACK_FINGERPRINT_SECRET=\S+/m);
  }
});

test("frontend feedback remains same-origin, bounded, and plain React text", async () => {
  const [client, panel, page] = await Promise.all([
    read("app/public-data/feedback-client.ts"),
    read("app/PublicFeedbackPanel.tsx"),
    read("app/page.tsx"),
  ]);
  assert.match(client, /`\/api\/v1\/publications\/\$\{input\.publicationId\}\/feedback`/);
  assert.match(client, /X-Hai-Dau-Feedback/);
  assert.doesNotMatch(client, /Authorization|credentials\s*:/);
  assert.match(panel, /maxLength=\{280\}/);
  assert.match(panel, /Báo lỗi nội dung/);
  assert.doesNotMatch(`${client}\n${panel}`, /dangerouslySetInnerHTML/);
  assert.match(page, /champion\.publicPublication[\s\S]*PublicFeedbackPanel/);
});

test("dedicated Sprint 7B workflow is read-only and deployment-free", async () => {
  const workflow = await read(".github/workflows/sprint-7b-feedback-intake.yml");
  assert.match(workflow, /^name: Sprint 7B feedback intake gate$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^    name: verify public feedback intake$/m);
  assert.match(workflow, /node-version: 22\.13\.0/);
  assert.match(workflow, /postgres:17/);
  assert.match(workflow, /redis:7/);
  assert.match(workflow, /npm run test:feedback-intake/);
  assert.match(workflow, /npm --prefix backend run typecheck/);
  assert.match(workflow, /npm --prefix backend test/);
  assert.match(workflow, /npm run build:pages/);

  const executable = workflow.split("- name: Deployment guard")[0];
  assert.doesNotMatch(workflow, /(contents|packages|pages|id-token):\s*write/);
  assert.doesNotMatch(executable, /railway|wrangler\s+deploy|git push|docker\s+(?:login|push)|kubectl|terraform|pulumi|actions\/deploy-pages/i);
  assert.doesNotMatch(workflow, /^\s*environment:\s*production\s*$/m);
  assert.doesNotMatch(workflow, /echo.*(?:SECRET|TOKEN|PASSWORD)/i);
});
