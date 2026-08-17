# Sprint 7C — Monitoring & Feedback Operator Surface Design

**Status:** self-approved under standing project delegation  
**Base:** `main@5e8aa27815a3ba0fc31dcee79c6bd9d80f49327f`  
**Scope:** local/internal read-only operator surface over Sprint 7A monitoring alerts and Sprint 7B feedback signals  
**Production delivery:** explicitly out of scope

## 1. Purpose

Sprint 7C gives an operator one consolidated place to inspect active post-publication monitoring alerts and recent community feedback without weakening the trust or Publication authorities already established.

The operator surface is observational and triage-only. It does not publish, roll back, retract, hide, moderate, change Eligibility, create Evidence, approve HumanReview, resolve monitoring alerts, or mutate anonymous feedback.

Authority remains:

`PostgreSQL monitoring/feedback authority -> read-only operator snapshot -> local operator console -> human decision outside this surface`

Any later trust or Publication mutation must continue through the existing dedicated authority commands.

## 2. Context and deployment boundary

The production gateway builds the Next.js app as a static export and serves the resulting `/out` tree publicly. Sprint 7B feedback details are explicitly operator-only, so a live operator dashboard must not be added to the public static app or bundled into the public gateway image.

Sprint 7C therefore adds a separate backend-side operator runtime:

- executable: `backend/dist/src/operator-server.js`;
- development command: `npm run operator:dev` inside `backend/`;
- production-style local command: `npm run operator` after backend build;
- default host: `127.0.0.1`;
- default port: `3011`;
- no Railway service/config;
- no Caddy route;
- no production gateway image change;
- no public API route;
- no browser credential or CORS expansion.

Binding to any non-loopback address is rejected by configuration in Sprint 7C. Remote access, if ever required later, must use a separately designed authenticated/tunneled operator boundary.

## 3. Approach selection

### Selected: dedicated loopback-only Fastify operator console

The backend already owns `pg` and Fastify. A dedicated runtime can reuse the trusted PostgreSQL readers from Sprint 7A and Sprint 7B while remaining isolated from the public backend composition.

This is preferred over:

1. **Public/static Next dashboard + operator token** — rejected because it would put an operator credential in a browser and expose a sensitive route through the public gateway.
2. **Build-time JSON snapshot inside the public app** — rejected because operator-only feedback details could be accidentally published and the data would be stale.
3. **New production-authenticated operator service** — deferred because identity, network exposure, secret provisioning and deployment policy are independent concerns that exceed this sprint.

## 4. Goals

1. Combine Sprint 7A open monitoring alerts and Sprint 7B feedback aggregates into one deterministic operator snapshot.
2. Group monitoring and feedback by `publicationId` and `publicationVersionId` without changing either source reader's authority semantics.
3. Rank actionable rows deterministically: critical monitoring first, then warning monitoring, then active-version feedback volume, then recency.
4. Expose a local loopback-only read-only HTTP console.
5. Provide bounded filtering and drill-down for alert severity/code, feedback reason counts and recent detail samples.
6. Keep all operator responses non-cacheable.
7. Keep the runtime usable if Redis/workers are unavailable; PostgreSQL is the only data dependency.
8. Fail closed when PostgreSQL readers detect stale/invalid monitoring pointers.
9. Preserve Sprint 7B privacy boundaries; no raw IP/fingerprint/auth/cookie/session/contact data exists in operator models.
10. Add runbook, dedicated repository contract and CI gate.

## 5. Non-goals

Sprint 7C does not add production deployment, production operator authentication, SSO, public operator routes, browser tokens, CORS, WebSocket/SSE, polling, automatic refresh, email/Slack notifications, alert acknowledgement/resolution writes, feedback deletion/editing, feedback-to-Evidence conversion, review decisions, Moderation, Eligibility, Publication mutation, rollback, or automated triage.

## 6. Operator snapshot model

Add `backend/src/modules/operator/read-operator-publication-signals.ts`.

The outward model is:

```ts
export type OperatorPublicationSignal = {
  publicationId: string;
  publicationVersionId: string;
  isActiveVersion: boolean;
  priority: 'critical' | 'warning' | 'feedback';
  monitoringAlert: null | {
    alertCode:
      | 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED'
      | 'ACTIVE_PUBLICATION_NEEDS_REVIEW'
      | 'ACTIVE_PUBLICATION_INELIGIBLE';
    severity: 'warning' | 'critical';
    evaluatedAt: string;
    candidateRevisionId: string;
    eligibilityOutcome: 'eligible' | 'needs_review' | 'ineligible' | null;
    eligibilityReason: string | null;
  };
  feedback: null | {
    totalCount: number;
    countsByReason: Partial<Record<FeedbackReasonCode, number>>;
    newestReceivedAt: string;
    recentDetails: Array<{
      reasonCode: FeedbackReasonCode;
      details: string;
      receivedAt: string;
    }>;
  };
};
```

Snapshot envelope:

```ts
export type OperatorSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  sinceHours: number;
  summary: {
    critical: number;
    warning: number;
    feedbackOnly: number;
    total: number;
  };
  signals: OperatorPublicationSignal[];
};
```

## 7. Join and ranking rules

The operator reader calls existing readers only:

- `readOpenPublicationMonitoringAlerts(pool)`;
- `readPublicationFeedbackSignals(pool, { sinceHours, limit, detailSampleLimit, now })`.

It must not duplicate or bypass their SQL authority checks.

Join key is exact `(publicationId, publicationVersionId)`.

Rules:

1. an open monitoring alert produces one signal row;
2. matching feedback is attached to that row;
3. feedback for a version with no open monitoring alert produces a feedback-only row;
4. monitoring rows are necessarily active-version rows because the Sprint 7A reader fails closed on stale pointers;
5. historical feedback-only rows retain `isActiveVersion=false` from the Sprint 7B reader;
6. `priority` is `critical` for critical monitoring, `warning` for warning monitoring, otherwise `feedback`;
7. deterministic sort order:
   - priority: critical, warning, feedback;
   - active version before historical version;
   - feedback `totalCount` descending;
   - newest timestamp descending, using alert `evaluatedAt` and feedback `newestReceivedAt`;
   - `publicationId`, then `publicationVersionId` ascending.

The combined reader is read-only and contains no SQL mutation.

## 8. Query bounds

The operator runtime accepts only bounded GET query parameters:

- `sinceHours`: integer `1..720`, default `168`;
- `limit`: integer `1..100`, default `50`;
- `detailSampleLimit`: integer `0..5`, default `3`.

Invalid values return HTTP 400; values are not silently coerced at the HTTP boundary.

The internal reader receives explicit bounded values and a single captured `now` so monitoring/feedback presentation is deterministic for one request.

## 9. HTTP surface

Dedicated operator runtime routes:

- `GET /health/live` -> `{ status: 'live' }`;
- `GET /health/ready` -> checks PostgreSQL only;
- `GET /api/operator/v1/snapshot` -> closed JSON operator snapshot;
- `GET /` -> operator HTML shell;
- `GET /operator.js` -> small static JS client;
- `GET /operator.css` -> static stylesheet.

No POST/PUT/PATCH/DELETE route is registered.

Every operator response includes:

- `Cache-Control: no-store`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- `Content-Security-Policy` that allows only the console's own script/style and forbids external connections, frames and objects.

JSON responses are created field-by-field; no database row spreading.

## 10. Loopback-only configuration

Add a dedicated parser that reads:

- `OPERATOR_HOST`, default `127.0.0.1`;
- `OPERATOR_PORT`, default `3011`;
- existing `DATABASE_URL`.

Allowed host values are exactly:

- `127.0.0.1`;
- `::1`;
- `localhost`.

Any other host fails startup with `OPERATOR_HOST must be loopback-only`.

The operator runtime does not read `REDIS_URL`, feedback fingerprint secret, Railway variables or publisher credentials.

## 11. UI behavior

The UI is intentionally compact and operational rather than editorial.

Header shows:

- generated-at timestamp;
- current lookback window;
- critical/warning/feedback-only counts.

Filters:

- all;
- critical;
- warning;
- feedback-only;
- active version only;
- free-text local search across IDs and reason-code labels already present in the snapshot.

Each signal card shows:

- priority badge;
- publication/version IDs;
- monitoring alert code/severity/evaluation time if present;
- eligibility outcome/reason if present;
- feedback total and reason breakdown if present;
- bounded recent feedback details as plain text;
- historical-version badge when applicable.

The page performs one snapshot GET on load and offers a manual `Làm mới` button. Sprint 7C adds no polling or automatic refresh timer.

No UI element invokes trust or Publication mutation endpoints.

## 12. Privacy and rendering

Feedback detail strings are untrusted community text.

The console:

- renders details with `textContent`, never `innerHTML`;
- does not create hyperlinks from details;
- does not persist snapshot data in localStorage/sessionStorage/IndexedDB;
- does not send telemetry;
- does not fetch external assets;
- does not log detail strings server-side;
- does not expose stack traces, SQL, connection URLs or source errors to the client.

## 13. Failure behavior

### PostgreSQL unavailable

- `/health/ready` -> 503;
- `/api/operator/v1/snapshot` -> 503 sanitized `OPERATOR_SNAPSHOT_UNAVAILABLE`;
- HTML/CSS/JS shell remains available so the operator sees a clear unavailable state.

### Stale monitoring pointer

If the Sprint 7A reader raises its fail-closed stale-pointer error, snapshot GET returns sanitized 503. The console does not omit the problematic alert and pretend the system is healthy.

### No signals

Snapshot returns 200 with zero summary counts and `signals: []`.

### Malformed query

Returns 400 with a closed error code; no reader call is made.

## 14. Authority isolation invariants

Dedicated contracts must prove that production operator modules do not import:

- publish/rollback commands;
- Evidence mutation commands;
- HumanReview mutation commands;
- Moderation mutation commands;
- Eligibility mutation commands;
- monitoring evaluator/alert transition commands;
- feedback submission authority;
- Redis/BullMQ queue modules.

Operator production code may depend only on PostgreSQL, the two read boundaries, Fastify and pure formatting/configuration helpers.

Repository contracts also prove:

- no production/staging Caddy route contains `/operator`;
- no Railway file starts the operator runtime;
- gateway Dockerfile does not copy/build operator assets;
- no write HTTP method is registered in the operator server;
- operator server's default/allowed bind hosts are loopback only.

## 15. Files

Create:

- `backend/src/modules/operator/types.ts`
- `backend/src/modules/operator/read-operator-publication-signals.ts`
- `backend/src/operator/config.ts`
- `backend/src/operator/http.ts`
- `backend/src/operator/assets.ts`
- `backend/src/operator-server.ts`
- `backend/test/operator-signal-reader.test.ts`
- `backend/test/operator-http.test.ts`
- `backend/test/operator-config.test.ts`
- `backend/test/operator-authority-isolation.test.ts`
- `tests/operator-surface-contract.test.mjs`
- `docs/runbooks/operator-surface.md`
- `.github/workflows/sprint-7c-operator-surface.yml`

Modify:

- `backend/package.json`
- root `package.json`

No migration is required.

## 16. Required tests

1. combined reader emits monitoring-only row;
2. combined reader attaches matching feedback to the exact PublicationVersion;
3. feedback-only active row is emitted;
4. historical feedback-only row is retained and labelled inactive;
5. same Publication with different versions never cross-joins;
6. critical > warning > feedback deterministic ordering;
7. equal-priority rows sort by active state, feedback volume, recency and IDs;
8. empty readers return empty snapshot;
9. summary counts are exact;
10. bounded lookback/limit/detail options pass through to feedback reader;
11. reader performs no mutation and imports only read boundaries;
12. operator config defaults to loopback/3011;
13. `127.0.0.1`, `::1`, `localhost` accepted;
14. `0.0.0.0`, public/private LAN IP and arbitrary hostname rejected;
15. snapshot route validates strict integer query bounds;
16. snapshot route returns closed schema;
17. PostgreSQL/read failure is sanitized to 503;
18. health readiness checks PostgreSQL only;
19. static shell/assets include no external URL dependencies;
20. detail rendering path uses `textContent` and contains no `innerHTML`;
21. only GET operator routes exist;
22. all operator responses set no-store/security headers;
23. repository contract proves no Caddy/Railway/operator public deployment wiring;
24. repository contract proves no mutation/queue authority imports;
25. root Sprint 7C contract, backend typecheck/full tests/build and existing regression/staging/release gates remain green.

## 17. CI and completion gate

Add `Sprint 7C operator surface gate` with:

- Node `22.13.0`;
- PostgreSQL `17`;
- root/backend `npm ci`;
- root `test:operator-surface` repository contract;
- backend typecheck;
- full backend test suite;
- backend build;
- repository cleanliness;
- deployment guard.

Sprint 7C is repository-ready only when exact-head dedicated 7C, inherited regression, staging integration, release candidate and deploy dry-run workflows all succeed and review finds no Critical/Important issue.

## 18. Completion boundary

A merged Sprint 7C means only that the repository contains a loopback-only operator console and its verification coverage.

It does **not** mean:

- production operator access exists;
- production has been deployed;
- feedback intake is enabled in production;
- production secrets are provisioned;
- monitoring automatically changes Publication state.

Any remote/production operator access must be designed and gated separately.
