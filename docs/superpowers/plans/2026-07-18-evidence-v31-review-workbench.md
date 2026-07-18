# Evidence v3.1 Review Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, public review workbench that exports exact game-ID review packages and a validated repository CLI that persists those choices without bypassing moderation.

**Architecture:** A pure review library owns catalog construction, package validation, and override application. A CLI imports downloaded packages atomically into a durable override file; the collector applies valid overrides before Evidence v3 signature hardening. A statically generated `/review/` route exposes only safe candidate metadata and performs all browser editing locally.

**Tech Stack:** Node.js ESM, Next.js 16 static export, React 19, TypeScript, CSS Modules, Node test runner.

## Global Constraints

- The browser must never contain a GitHub token or make authenticated write requests.
- Raw HTML, descriptions, subtitles, transcripts, comments and image bytes must never enter review output.
- A review requires exactly one champion, at least one augment, at least two items and `attested: true`.
- Review selections do not count as an independent community source and do not bypass moderation.
- All IDs and icons must come from the current generated Riot/CommunityDragon catalog.

---

### Task 1: Pure review package and override rules

**Files:**
- Create: `scripts/lib/community-review-v31.mjs`
- Create: `tests/community-review-v31.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `buildReviewCatalog(guides)`, `validateReviewPackage(value, context)` and `applyReviewOverrides(candidates, overrides, catalog)`.

- [ ] Write failing tests for catalog dedupe, valid package normalization, rejection of mismatched URLs/unknown IDs, and override application.
- [ ] Run `node --test tests/community-review-v31.test.mjs`; expect failures because the module is absent.
- [ ] Implement the smallest pure functions that satisfy the tests and emit only structured IDs/provenance.
- [ ] Add the test file to `test:moderation` and rerun it; expect all tests to pass.

### Task 2: Durable import CLI and collector integration

**Files:**
- Create: `scripts/apply-community-review-package.mjs`
- Create: `data/community-review-overrides.json`
- Modify: `scripts/collect-community-candidates.mjs`
- Modify: `package.json`
- Test: `tests/community-review-v31.test.mjs`

**Interfaces:**
- Consumes a package path from `npm run review:apply -- <path>`.
- Produces atomic `data/community-review-overrides.json` and collector candidates with `reviewer-selection` provenance.

- [ ] Add a failing test proving a complete override becomes signature-ready while stale/locked candidates remain blocked.
- [ ] Implement CLI schema validation and atomic merge keyed by `candidateId`.
- [ ] Read/validate the override file in collector, include its stable hash, and apply reviews before `enforceEvidenceV3Signature`.
- [ ] Run review tests and `npm run validate:community`; expect success.

### Task 3: Static review route

**Files:**
- Create: `app/review/page.tsx`
- Create: `app/review/ReviewWorkbench.tsx`
- Create: `app/review/review.module.css`
- Modify: `app/page.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes safe actionable candidates and the build-time catalog.
- Produces a client-side downloadable `evidence-v31-review-package.json` only.

- [ ] Add rendered/source assertions for the `/review/` route, exact-ID pickers, attestation, download and no authenticated writes.
- [ ] Run the rendered test; expect failure because the route does not exist.
- [ ] Implement the server mapping and client workbench with filtering, searchable pickers, completion preview and package download.
- [ ] Add a visible link from the main moderation panel and responsive CSS.
- [ ] Build Pages and run rendered tests; expect `/review/index.html` and all assertions to pass.

### Task 4: Audit, documentation and deployment

**Files:**
- Modify: `README.md`
- Modify: generated static root files from `out/`

- [ ] Document the review/apply/sync workflow and its security boundaries.
- [ ] Run `npm run sync:data`, `npm run validate:community`, `npm run lint`, `npm test`, and `npm run build:pages`.
- [ ] Sync `out/` to the GitHub Pages root, preserving `.nojekyll` and deleting only unreferenced bundles.
- [ ] Commit, fast-forward `main`, and verify `/`, `/review/`, and every referenced CSS/JS return HTTP 200.
