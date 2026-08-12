# Sprint 5B Frontend Public-Data Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the static public guide UI to the read-only Publication API with a validated client-side overlay and fail-safe static fallback.

**Architecture:** Keep the existing static `champions` collection as the initial render and source of localized metadata/assets. A narrow GET-only adapter validates the complete API envelope, a pure merge function overlays active Publication augment/item IDs onto matching champions, and a React hook performs one hydration-time request when `NEXT_PUBLIC_PUBLIC_API_BASE_URL` is configured.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Node.js 22 built-in test runner, GitHub Pages static export.

## Global Constraints

- `NEXT_PUBLIC_PUBLIC_API_BASE_URL` is optional and is the only frontend API-origin configuration.
- The browser performs at most one `GET /api/v1/publications` request per mounted page instance.
- Keep the existing Vietnamese title, summary, champion metadata, images, tips, traps, alternatives, and editorial source fields.
- Replace only the primary `coreAugments`, `items`, and `itemData` when a Publication is valid and fully resolvable.
- No `POST`, `PUT`, `PATCH`, `DELETE`, retry, polling, timer, service worker, automatic publication, authenticated browser write, merge, or deployment.
- GitHub Pages without the environment variable must build and render the complete static guide without network dependency.

---

### Task 1: Closed Publication contract and GET-only adapter

**Files:**
- Create: `app/public-data/types.ts`
- Create: `app/public-data/parse-publications.ts`
- Create: `app/public-data/http-publication-adapter.ts`
- Create: `tests/public-data-adapter.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `parsePublicPublicationList(input: unknown): PublicPublicationListV1`
- Produces: `fetchPublications({ apiBaseUrl, signal, fetchImpl }): Promise<PublicPublicationListV1>`

- [ ] **Step 1: Write failing parser and HTTP tests**

Create tests that import the not-yet-created modules and assert:

```ts
const parsed = parsePublicPublicationList(validEnvelope);
assert.equal(parsed.publications[0].payload.championExternalId, "samira");
assert.throws(
  () => parsePublicPublicationList({ ...validEnvelope, unexpected: true }),
  PublicPublicationContractError,
);
```

The HTTP test supplies a recording `fetchImpl`, verifies the URL is `<base>/api/v1/publications`, verifies `init.method === "GET"`, and verifies a non-2xx response rejects without a second call.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/public-data-adapter.test.ts
```

Expected: FAIL because `app/public-data/parse-publications.ts` and `app/public-data/http-publication-adapter.ts` do not exist.

- [ ] **Step 3: Implement exact types and parser**

Define the closed keys:

```ts
export type PublicPublicationV1 = {
  publicationId: string;
  candidateId: string;
  candidateRevisionId: string;
  publicationVersionId: string;
  versionNumber: number;
  publishedAt: string;
  payload: {
    schemaVersion: 1;
    mode: "aram_mayhem";
    patchKey: string;
    catalogRevisionId: string;
    championExternalId: string;
    augmentExternalIds: string[];
    itemExternalIds: string[];
  };
};
```

Use explicit object/array/string/integer checks and exact-key checks. Reject empty identifiers, invalid dates, duplicate augment/item IDs, fewer than one augment, fewer than two items, wrong schema versions, and unknown keys.

- [ ] **Step 4: Implement the GET-only adapter**

Normalize trailing slashes and call:

```ts
fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}/api/v1/publications`, {
  method: "GET",
  headers: { accept: "application/json" },
  signal,
});
```

Reject non-2xx responses with a generic `PublicPublicationRequestError`; parse JSON once; delegate to the closed parser; do not retry.

- [ ] **Step 5: Add the focused test script and verify GREEN**

Add:

```json
"test:public-data": "node --experimental-strip-types --test tests/public-data-adapter.test.ts"
```

Run `npm run test:public-data`; expected PASS.

- [ ] **Step 6: Commit**

```bash
git add app/public-data tests/public-data-adapter.test.ts package.json
git commit -m "feat: add closed public Publication adapter"
```

### Task 2: Deterministic static-guide overlay

**Files:**
- Create: `app/public-data/merge-publications.ts`
- Modify: `app/data.ts`
- Modify: `tests/public-data-adapter.test.ts`

**Interfaces:**
- Consumes: `PublicPublicationV1`, `ChampionGuide`
- Produces: `mergePublicationsIntoGuides(guides, publications): ChampionGuide[]`
- Produces: optional `ChampionGuide.publicPublication: PublicPublicationMetadata`

- [ ] **Step 1: Write failing merge tests**

Use two static champions with numeric augment/item IDs and assert:

```ts
const merged = mergePublicationsIntoGuides(guides, publications);
assert.equal(merged[0].buildName, guides[0].buildName);
assert.deepEqual(merged[0].coreAugments.map((value) => value.id), [1194]);
assert.deepEqual(merged[0].itemData?.map((value) => value.id), [3006, 6672]);
assert.equal(merged[0].publicPublication?.patchKey, "26.15");
```

Add separate tests for unknown IDs preserving the exact original champion object and for deterministic winner selection by `publishedAt`, `versionNumber`, and `publicationId`.

- [ ] **Step 2: Run focused tests and verify RED**

Run `npm run test:public-data`; expected FAIL because `merge-publications.ts` and `publicPublication` do not exist.

- [ ] **Step 3: Extend the guide type**

Add:

```ts
publicPublication?: PublicPublicationMetadata;
```

Import the metadata type with `import type` only.

- [ ] **Step 4: Implement pure merge logic**

Build global localized asset maps from all guides using `String(asset.id)`. Group Publications by normalized lower-case champion ID. Select the deterministic winner. Apply an overlay only when every external ID resolves; otherwise return the original champion object unchanged. Preserve every static field except `coreAugments`, `items`, `itemData`, and the attached metadata.

- [ ] **Step 5: Verify GREEN and commit**

Run `npm run test:public-data`; expected PASS.

```bash
git add app/data.ts app/public-data/merge-publications.ts tests/public-data-adapter.test.ts
git commit -m "feat: overlay active Publications onto static guides"
```

### Task 3: One-shot React hook and public UI wiring

**Files:**
- Create: `app/public-data/use-public-guides.ts`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `tests/public-data-adapter.test.ts`

**Interfaces:**
- Consumes: static guides, optional API base URL, HTTP adapter, merge function
- Produces: `{ guides, status, publicationCount }`

- [ ] **Step 1: Write failing source-contract and rendered-copy tests**

Assert the page/hook source contains `NEXT_PUBLIC_PUBLIC_API_BASE_URL`, `usePublicGuides`, the four approved status strings, and `API · Bản`. Assert the complete public-data source does not contain mutation methods, `setInterval`, `setTimeout`, recursive retry calls, `authorization`, `token`, or auto-publish behavior.

- [ ] **Step 2: Run focused and rendered tests to verify RED**

Run:

```bash
npm run test:public-data
npm run build:pages
node --test tests/rendered-html.test.mjs
```

Expected: the new source-contract/status tests FAIL because the hook and UI wiring do not exist.

- [ ] **Step 3: Implement the one-shot hook**

Use initial state `{ guides: staticGuides, status: apiBaseUrl ? "loading" : "static" }`. In one `useEffect`, skip when URL is absent, create one `AbortController`, call `fetchPublications` once, merge results, set `live`, and catch non-abort failures by restoring static guides with `fallback`. Cleanup only calls `controller.abort()`.

- [ ] **Step 4: Wire all page calculations to hook guides**

Replace module-level metrics derived directly from `champions` with `useMemo` values derived from `guides`. Use `guides` for filtering, counts, cards, and selected champion lookup. Read the base URL as:

```ts
const apiBaseUrl = process.env.NEXT_PUBLIC_PUBLIC_API_BASE_URL;
```

Render a compact status line and render `API · Bản {patchKey}` plus version/time metadata for overlaid builds.

- [ ] **Step 5: Add minimal status styling**

Add focused classes for the compact status row and API pill. Do not restructure unrelated layout or alter the Evidence review surface.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run test:public-data
npm run build:pages
node --test tests/rendered-html.test.mjs
npm run lint
```

Expected: PASS and the static build contains `Dữ liệu tĩnh` with no API configuration.

```bash
git add app/page.tsx app/globals.css app/public-data/use-public-guides.ts tests
git commit -m "feat: connect public guide UI to Publication reads"
```

### Task 4: Workflow, documentation, and exact-head gate

**Files:**
- Modify: `.github/workflows/backend-production-foundation.yml`
- Modify: `README.md`
- Modify: `backend/README.md`

**Interfaces:**
- Produces: repeatable Sprint 5B CI evidence and configuration documentation

- [ ] **Step 1: Write failing workflow/documentation assertions**

Extend the repository contract test to require the workflow name `Sprint 5B frontend public data gate`, `npm run test:public-data`, and documentation of `NEXT_PUBLIC_PUBLIC_API_BASE_URL`, one-shot GET behavior, static fallback, and scope exclusions.

- [ ] **Step 2: Run tests and verify RED**

Run `npm run test:public-data`; expected FAIL because workflow/docs still describe Sprint 5A.

- [ ] **Step 3: Update workflow and docs**

Keep PostgreSQL 17, Redis 7, `contents: read`, backend verification, repository cleanliness, credential scanning, deployment-command scanning, and production-deployment disablement. Add the focused frontend adapter test before the canonical Pages build.

- [ ] **Step 4: Run the complete local gate**

Run:

```bash
npm run validate:community
npm run lint
npm test
npm run backend:typecheck
npm run backend:test
npm run backend:build
git diff --check
```

Expected: all PASS, with no working-tree change generated by verification.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/backend-production-foundation.yml README.md backend/README.md tests
git commit -m "ci: add Sprint 5B public data gate"
```

- [ ] **Step 6: Push and open a draft PR**

Push `feat/5b-frontend-public-data-adapter` and open a draft PR against `main`. State that it is stacked on exact Sprint 5A head `0cb55716f7be16d549e46bc20847fca61d1939c5`, remains unmerged, and does not deploy.

- [ ] **Step 7: Verify the exact head in GitHub Actions**

Require the Sprint 5B gate and deploy dry run to pass on the exact PR head. Inspect job steps/logs and record run IDs, frontend/backend test counts, cleanliness, deployment guard, and disabled production publishing in the PR body.

- [ ] **Step 8: Final review**

Review exact range `0cb55716f7be16d549e46bc20847fca61d1939c5..<Sprint-5B-head>` for schema openness, browser credentials, mutation methods, retries/timers, automatic publication, unrelated refactors, merge, and deployment. Resolve all Critical or Important findings before declaring Sprint 5B complete.
