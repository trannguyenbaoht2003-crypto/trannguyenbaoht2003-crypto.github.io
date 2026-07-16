# Automatic Community Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, auditable pipeline that automatically approves or demotes ARAM: Mayhem community builds using exact game IDs, cross-source confirmation, trusted-creator engagement, patch freshness, and public feedback signals.

**Architecture:** Keep candidate collection, pure moderation decisions, generated publishing data, and UI presentation in separate units. The collector enriches candidates with structured public metrics; a pure rule engine evaluates hard gates and evidence; a runner persists evidence/decisions/generated sources; the app merges generated records with curated records without letting automatic data overwrite Hải Đấu or curated content.

**Tech Stack:** Node.js 22 ESM, `node:test`, Next.js 16, React 19, TypeScript, JSON data files, GitHub Pages static export.

## Global Constraints

- Website remains responsive web only: no PWA, service worker, web manifest, or installation prompt.
- Never bypass login/CAPTCHA or access locked WeChat mini-program content.
- Never store full articles, transcripts, or comment bodies.
- Never present views, engagement, moderation scores, or sentiment as win rate.
- Every published champion, augment, and item must match a current client ID and image.
- Preserve Chinese names beside Vietnamese translations.
- Automatic records must never overwrite Hải Đấu or curated community records.
- Network/source failure requires two consecutive scans before demotion.
- Volatile metrics do not change content hashes unless a decision, state, reason, source, ID, or approval path changes.

---

### Task 1: Pure moderation rule engine

**Files:**
- Create: `scripts/lib/community-moderation.mjs`
- Create: `tests/community-moderation.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseSignalMetrics(signal)`, `weightedEngagementRate(metrics)`, `buildSignature(candidate)`, `evaluateCandidate(candidate, context)`, `moderateCandidates(input)`, `stableDecisionHash(value)`.
- Consumes: plain candidate, registry policy, current patch, previous decisions, current time.

- [ ] **Step 1: Write failing tests for both approval paths and hard gates**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCandidate,
  moderateCandidates,
  stableDecisionHash,
} from "../scripts/lib/community-moderation.mjs";

test("approves two independent sources with the same exact build", () => {
  const result = moderateCandidates({
    candidates: [fixture({ author: "A", url: "https://a.example/1" }), fixture({ author: "B", url: "https://b.example/2" })],
    policy,
    currentPatch: "16.14",
    now: "2026-07-16T12:00:00.000Z",
    previousDecisions: [],
  });
  assert.equal(result.decisions[0].status, "auto-approved");
  assert.equal(result.decisions[0].approvalPath, "cross-source");
});

test("approves an established creator with strong public engagement", () => {
  const decision = evaluateCandidate(fixture({
    authorTier: "established",
    publishedAt: "2026-07-15",
    metrics: { views: 5000, likes: 120, coins: 20, favorites: 15 },
  }), context());
  assert.equal(decision.status, "auto-approved");
  assert.equal(decision.approvalPath, "trusted-creator");
});

test("rejects high views with weak engagement", () => {
  const decision = evaluateCandidate(fixture({
    authorTier: "established",
    metrics: { views: 100000, likes: 20, coins: 0, favorites: 0 },
  }), context());
  assert.notEqual(decision.status, "auto-approved");
});

test("blocks a candidate with missing exact item evidence", () => {
  const decision = evaluateCandidate(fixture({ itemMatches: [] }), context());
  assert.equal(decision.status, "observing");
  assert.ok(decision.hardGateFailures.includes("missing-item-evidence"));
});
```

- [ ] **Step 2: Run the new test file and verify RED**

Run: `node --test tests/community-moderation.test.mjs`

Expected: FAIL because `scripts/lib/community-moderation.mjs` does not exist.

- [ ] **Step 3: Implement the minimum pure rule engine**

```js
export function weightedEngagementRate(metrics = {}) {
  if (!Number.isFinite(metrics.views) || metrics.views <= 0) return 0;
  return ((metrics.likes ?? 0) + 2 * (metrics.coins ?? 0) + 3 * (metrics.favorites ?? 0)) / metrics.views;
}

export function buildSignature(candidate) {
  const champion = candidate.championMatches?.[0]?.id;
  const augments = [...(candidate.augmentMatches ?? [])].map((entry) => entry.id).sort((a, b) => a - b);
  const items = [...(candidate.itemMatches ?? [])].map((entry) => entry.id).sort((a, b) => a - b);
  return champion ? `${champion}:${augments.join("-")}:${items.join("-")}` : undefined;
}

export function stableDecisionHash(value) {
  return createHash("sha256").update(JSON.stringify(normalizeDecisionContent(value))).digest("hex");
}
```

Implement score weights and the two approval paths exactly as specified in the design. Hard-gate failures always prevent approval even when the numeric score is high.

- [ ] **Step 4: Add demotion, source-independence, negative-feedback, and stable-hash tests**

```js
test("does not count two URLs by the same author as independent", () => {
  const result = moderateCandidates({
    candidates: [fixture({ author: "A", url: "https://a.example/1" }), fixture({ author: "A", url: "https://a.example/2" })],
    policy,
    currentPatch: "16.14",
    now: "2026-07-16T12:00:00.000Z",
    previousDecisions: [],
  });
  assert.notEqual(result.decisions[0].status, "auto-approved");
});

test("demotes after a patch change without reconfirmation", () => {
  const decision = evaluateCandidate(fixture({ patchHint: "16.13" }), context({
    currentPatch: "16.14",
    previousDecision: { status: "auto-approved", patch: "16.13", consecutiveFailures: 0 },
  }));
  assert.equal(decision.status, "needs-verification");
});

test("demotes when negative comments reach 35 percent", () => {
  const decision = evaluateCandidate(fixture({
    comments: { positive: 6, negative: 4, neutral: 0, meaningful: 10 },
  }), context({ previousDecision: { status: "auto-approved", patch: "16.14", consecutiveFailures: 0 } }));
  assert.equal(decision.status, "needs-verification");
});

test("one source failure keeps approval but the second demotes", () => {
  const first = evaluateCandidate(fixture({ accessState: "temporary-error" }), context({
    previousDecision: { status: "auto-approved", patch: "16.14", consecutiveFailures: 0 },
  }));
  const second = evaluateCandidate(fixture({ accessState: "temporary-error" }), context({
    previousDecision: first,
  }));
  assert.equal(first.status, "auto-approved");
  assert.equal(second.status, "needs-verification");
});

test("volatile metric changes keep the same decision hash", () => {
  const left = [{ status: "auto-approved", signature: "ryze:1:2", checkedAt: "2026-07-16T10:00:00Z", metrics: { views: 1000 } }];
  const right = [{ status: "auto-approved", signature: "ryze:1:2", checkedAt: "2026-07-16T11:00:00Z", metrics: { views: 1200 } }];
  assert.equal(stableDecisionHash(left), stableDecisionHash(right));
});
```

- [ ] **Step 5: Run the moderation tests and verify GREEN**

Run: `node --test tests/community-moderation.test.mjs`

Expected: all moderation tests pass with zero failures.

- [ ] **Step 6: Add the targeted test script**

```json
"test:moderation": "node --test tests/community-moderation.test.mjs"
```

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/community-moderation.mjs tests/community-moderation.test.mjs package.json
git commit -m "feat: add automatic moderation rule engine"
```

---

### Task 2: Structured public evidence collection

**Files:**
- Modify: `scripts/collect-community-candidates.mjs`
- Modify: `app/community-source-registry.json`
- Modify: `tests/community-moderation.test.mjs`

**Interfaces:**
- Consumes: Bilibili public search/detail APIs and existing Bing RSS adapters.
- Produces: candidates with `metrics`, `authorTier`, `accessState`, and exact game matches while retaining the human-readable `signal` field.

- [ ] **Step 1: Write failing tests for legacy signal parsing and source identity**

```js
test("parses legacy Vietnamese signal text into structured metrics", () => {
  assert.deepEqual(parseSignalMetrics("5000 lượt xem · 120 lượt thích · 15 lượt lưu"), {
    views: 5000,
    likes: 120,
    favorites: 15,
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:moderation`

Expected: FAIL until legacy parsing and normalization are implemented.

- [ ] **Step 3: Extend Bilibili collection**

Add structured metrics from search rows and enrich candidates that contain exact champion/augment/item evidence through the public `x/web-interface/view?bvid=` endpoint. Persist only aggregate counts:

```js
metrics: {
  views: finite(row.play),
  likes: finite(row.like),
  favorites: finite(row.favorites),
  coins: finite(detail?.stat?.coin),
  comments: finite(detail?.stat?.reply),
}
```

Do not fetch or persist full comment bodies. Preserve source failures as `accessState: "temporary-error"` rather than removing candidates.

- [ ] **Step 4: Replace the registry policy with explicit moderation thresholds**

```json
"policy": {
  "autoPublish": true,
  "requireExactGameId": true,
  "minimumReviewScore": 75,
  "crossSourceWindowDays": 45,
  "maxInboxItems": 500,
  "storeFullArticleOrTranscript": false,
  "moderation": {
    "crossSourceMinimumScore": 85,
    "trustedCreatorMinimumScore": 90,
    "minimumSimilarity": 0.75,
    "minimumSourceAgeHours": 12,
    "minimumViews": 1000,
    "minimumPositiveActions": 20,
    "minimumWeightedEngagementRate": 0.02,
    "minimumCommentSample": 10,
    "minimumPositiveCommentRatio": 0.7,
    "demoteNegativeCommentRatio": 0.35,
    "consecutiveFailureLimit": 2
  }
}
```

- [ ] **Step 5: Update collector validation and stable normalization**

Allow `autoPublish: true`, require every moderation threshold, and include structured metrics in the inbox while keeping volatile metrics out of the watch report content hash unless candidate state or threshold classification changes.

- [ ] **Step 6: Run tests and collector validation**

Run: `npm run test:moderation && node scripts/collect-community-candidates.mjs --validate-only`

Expected: both commands pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/collect-community-candidates.mjs app/community-source-registry.json tests/community-moderation.test.mjs
git commit -m "feat: collect structured community evidence"
```

---

### Task 3: Moderation runner, decision log, and generated source data

**Files:**
- Create: `scripts/moderate-community-candidates.mjs`
- Create: `data/community-evidence.json`
- Create: `data/community-decisions.json`
- Create: `app/generated-community-sources.json`
- Create: `community-moderation-report.json`
- Modify: `package.json`
- Modify: `tests/community-moderation.test.mjs`

**Interfaces:**
- Consumes: inbox, registry, generated guides, curated sources, previous decisions.
- Produces: evidence, decisions, generated sources, and a stable moderation report.

- [ ] **Step 1: Write failing generation tests**

```js
test("creates one generated record from two approved duplicate sources", () => {
  const output = generatePublishedRecords({ decisions: approvedCrossSource, guides, curatedRecords: [] });
  assert.equal(output.records.length, 1);
  assert.equal(output.records[0].sources.length, 2);
  assert.match(output.records[0].canonicalKey, /^auto-/);
});

test("does not generate a record that duplicates curated or Hải Đấu data", () => {
  const output = generatePublishedRecords({ decisions: approved, guides, curatedRecords: [sameSignature] });
  assert.equal(output.records.length, 0);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:moderation`

Expected: FAIL because publishing helpers and runner outputs do not exist.

- [ ] **Step 3: Implement deterministic generated records**

For every approved decision, generate names and summaries only from verified game data and source titles:

```js
{
  championId,
  canonicalKey: `auto-${hash(signature).slice(0, 12)}`,
  relation: "candidate",
  title: `${coreVi.join(" + ")} — tổ hợp cộng đồng`,
  titleOriginal: `${championCn} · ${coreCn.join(" + ")}`,
  summary: `Các nguồn công khai cùng nêu tổ hợp ${coreVi.join(", ")} cho ${championVi}. Hệ thống chỉ đối chiếu lõi và trang bị theo ID game; không suy diễn tỷ lệ thắng.`,
  coreCn,
  itemCn,
  sources,
  automation: { status, approvalPath, checkedAt, patch, reasons, score }
}
```

If a decision is demoted, retain the record with `automation.status: "needs-verification"`. Never copy a full source description or transcript.

- [ ] **Step 4: Implement runner modes**

`node scripts/moderate-community-candidates.mjs` writes all four outputs atomically after validation. `--validate-only` loads and validates existing outputs without network access. It exits without writing when the stable moderation hash has not changed.

- [ ] **Step 5: Add package scripts and pipeline ordering**

```json
"moderate:community": "node scripts/moderate-community-candidates.mjs",
"sync:data": "node scripts/sync-public-apis.mjs && node scripts/sync-lolhaidou.mjs && node scripts/collect-community-candidates.mjs && node scripts/moderate-community-candidates.mjs && node scripts/validate-community-sources.mjs && node scripts/collect-community-candidates.mjs --validate-only && node scripts/moderate-community-candidates.mjs --validate-only",
"validate:community": "node scripts/validate-community-sources.mjs && node scripts/collect-community-candidates.mjs --validate-only && node scripts/moderate-community-candidates.mjs --validate-only"
```

- [ ] **Step 6: Run RED/GREEN verification and the runner**

Run: `npm run test:moderation && npm run moderate:community && node scripts/moderate-community-candidates.mjs --validate-only`

Expected: all pass; output JSON is deterministic and valid.

- [ ] **Step 7: Commit**

```bash
git add scripts/moderate-community-candidates.mjs data/community-evidence.json data/community-decisions.json app/generated-community-sources.json community-moderation-report.json package.json tests/community-moderation.test.mjs
git commit -m "feat: persist automatic moderation decisions"
```

---

### Task 4: Merge and validate automatic data without overwrites

**Files:**
- Modify: `scripts/validate-community-sources.mjs`
- Modify: `app/data.ts`
- Modify: `tests/community-moderation.test.mjs`

**Interfaces:**
- Consumes: curated and generated community source files.
- Produces: one deduplicated `CommunityBuild[]` per champion plus automatic moderation statistics.

- [ ] **Step 1: Write failing collision and schema tests**

```js
test("curated record wins a champion and canonical key collision", () => {
  const merged = mergeCommunityRecords({ curated: [curatedRecord], generated: [generatedCollision] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, curatedRecord.title);
});

test("generated record requires automation provenance", () => {
  assert.throws(() => validateGeneratedRecord({ ...generatedRecord, automation: undefined }), /automation/);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:moderation`

Expected: FAIL until merge/validation helpers exist.

- [ ] **Step 3: Extend validation**

Validate generated records with the same current client ID/image checks as curated records, plus:

- `automation.status` is `auto-approved` or `needs-verification`.
- `approvalPath` is `cross-source` or `trusted-creator` for approved records.
- `checkedAt`, `patch`, `reasons`, and `score` are valid.
- Curated collisions win and are reported rather than overwritten.

- [ ] **Step 4: Merge records in `app/data.ts`**

Import `generated-community-sources.json`, merge it after curated records, and map automatic provenance onto `CommunityBuild`:

```ts
status: automation?.status === "auto-approved"
  ? "Tự động đối chiếu"
  : automation?.status === "needs-verification"
    ? "Cần kiểm chứng"
    : isCurrent ? "Đã đối chiếu" : "Cần kiểm chứng";
```

Expose `approvalLabel`, `checkedAt`, `patch`, and `decisionReasons` to the UI. Extend `communitySourceStats` with automatic approved/demoted counts.

- [ ] **Step 5: Run validation and TypeScript build gate**

Run: `npm run test:moderation && npm run validate:community && npm run lint`

Expected: all pass with zero failures/errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/validate-community-sources.mjs app/data.ts tests/community-moderation.test.mjs
git commit -m "feat: merge validated automatic community builds"
```

---

### Task 5: Transparent automatic-decision UI

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `scripts/patch-static-watch-banner.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: automatic provenance on `CommunityBuild` and moderation stats.
- Produces: accessible public labels, evidence explanation, source links, and updated automation status.

- [ ] **Step 1: Write failing rendered HTML assertions**

```js
assert.match(html, /Kiểm duyệt tự động đang bật/i);
assert.match(html, /Không phải tỷ lệ thắng/i);
assert.match(html, /Hai nguồn độc lập|Nguồn uy tín \+ phản hồi tích cực/i);
```

- [ ] **Step 2: Verify RED against the current Pages build**

Run: `npm run build:pages && node --test tests/rendered-html.test.mjs`

Expected: FAIL because the automatic moderation copy is not rendered yet.

- [ ] **Step 3: Implement evidence presentation**

Update the source overview copy to state that strict automatic moderation is enabled. For automatic builds render:

```tsx
<div className="community-proof" aria-label="Bằng chứng kiểm duyệt tự động">
  <span>{build.approvalLabel}</span>
  <small>Đối chiếu {formatSourceDate(build.checkedAt?.slice(0, 10))} · Bản {build.patch}</small>
  <ul>{build.decisionReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
</div>
```

Use visible text plus color for states. Keep source links at least 44 px tall, preserve focus indicators, and avoid layout-shifting animation.

- [ ] **Step 4: Apply the existing Lõi.Meta design system**

Use existing dark surface, cyan/green verification, gold review, 12 px minimum evidence copy, 4.5:1 contrast, 150–200 ms transitions, responsive single-column cards below the current mobile breakpoint, and `prefers-reduced-motion` compatibility. Do not add a new font, icon library, PWA control, or install affordance.

- [ ] **Step 5: Update static fallback copy**

Make the patched GitHub Pages fallback state derive from the generated report or use neutral copy that cannot become numerically stale.

Change the main `test` script to target the actual deployment platform instead of the obsolete Sites worker build:

```json
"test": "npm run test:moderation && npm run build:pages && node --test tests/rendered-html.test.mjs"
```

- [ ] **Step 6: Run rendered tests, lint, and Pages build**

Run: `npm test && npm run lint && npm run build:pages`

Expected: all commands pass; `out/` contains the updated static site and `.nojekyll`.

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx app/globals.css tests/rendered-html.test.mjs scripts/patch-static-watch-banner.mjs
git commit -m "feat: explain automatic moderation on the web"
```

---

### Task 6: Documentation and full sync

**Files:**
- Modify: `README.md`
- Modify: generated sync/report/data files only when the full sync produces a meaningful stable-hash change.

**Interfaces:**
- Consumes: completed pipeline and source registry.
- Produces: reproducible operator documentation and synchronized data ready for the final interface pass.

- [ ] **Step 1: Update documentation**

Document both approval paths, demotion rules, JSON outputs, commands, the web-only constraint, and the statement that engagement is not win rate. Remove text claiming `autoPublish` must always be false.

- [ ] **Step 2: Run the complete sync once**

Run: `npm run sync:data`

Expected: collector, moderator, and validators complete. Newly generated records may remain empty when no candidate satisfies every hard gate; that is valid.

- [ ] **Step 3: Run the complete verification suite with fresh evidence**

Run: `npm run test:moderation && npm run validate:community && npm run lint && npm run build:pages`

Expected: all commands exit 0.

- [ ] **Step 4: Inspect the output contract**

Verify:

- `app/generated-community-sources.json` contains no collision with curated `championId + canonicalKey`.
- Every generated augment/item has an ID-backed image.
- `community-moderation-report.json` hash ignores volatile metric-only changes.
- `out/.nojekyll` exists.
- Static HTML references only CSS/JS files that exist under `out/_next/`.
- No manifest, service worker, or install CTA was introduced.

- [ ] **Step 5: Commit final documentation and meaningful generated changes**

```bash
git add README.md app/generated-community-sources.json data/community-evidence.json data/community-decisions.json community-moderation-report.json community-watch-report.json data/community-inbox.json
git commit -m "docs: document automatic community moderation"
```

- [ ] **Step 6: Confirm the branch is clean before the visual redesign**

Run: `git status --short`

Expected: no uncommitted files.

---

### Task 7: Hải Đấu-inspired responsive browsing and champion detail

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: existing champion data, curated community builds, automatic moderation provenance, and the user-provided Hải Đấu screenshots as the visual contract.
- Produces: compact discovery header, dense responsive champion grid, full champion detail surface, sticky section navigation, and build cards.

- [ ] **Step 1: Write failing static HTML assertions for the new information architecture**

```js
assert.match(html, /Kho tướng/i);
assert.match(html, /Lối lên đồ/i);
assert.match(html, /Lõi ưu tiên/i);
assert.match(html, /Cách chơi/i);
assert.match(html, /Nguồn/i);
```

Add source-level checks that the detail surface contains `role="dialog"`, an accessible close label, and section navigation anchors.

- [ ] **Step 2: Verify RED**

Run: `npm run build:pages && node --test tests/rendered-html.test.mjs`

Expected: FAIL because the current information architecture does not render the new labels and semantics.

- [ ] **Step 3: Rebuild the first viewport**

Replace the oversized marketing hero with a compact product header containing:

- Lõi.Meta title and ARAM: Mayhem subtitle.
- Stable counts for builds, heroes, automatic approvals, and items/augments when available.
- One large search field.
- Content tabs and role filters directly above the champion grid.

Do not reproduce WeChat chrome, QQ banners, ads, rankings, fake win rates, or install controls.

- [ ] **Step 4: Rebuild the champion grid**

Create portrait-first tiles with Vietnamese name, tier badge, optional favorite state, and available build count. Use four columns at 360–479 px, five at 480–767 px, and responsive desktop columns with a maximum content width. Preserve keyboard activation and at least 44 px interactive height.

- [ ] **Step 5: Rebuild champion detail**

Use a mobile full-screen dialog and desktop large modal. Add:

```tsx
<nav className="detail-tabs" aria-label="Điều hướng hướng dẫn tướng">
  <a href="#builds">Lối lên đồ</a>
  <a href="#augments">Lõi ưu tiên</a>
  <a href="#notes">Cách chơi</a>
  <a href="#sources">Nguồn</a>
</nav>
```

Render the Hải Đấu build first as a structured card with grade, tags, core augments, fallback augments, and numbered item order. Render community/automatic builds after it using the same card language plus moderation provenance.

- [ ] **Step 6: Apply the visual contract and accessibility rules**

Use the current dark token system with slate cards, cyan actions, green core groups, and rarity colors. Keep body copy at least 12 px inside dense cards and 16 px for normal page copy, contrast at least 4.5:1, visible focus, no horizontal scroll, no hover-only meaning, and reduced-motion support.

- [ ] **Step 7: Verify mobile and desktop behavior**

Run the Pages build, inspect 375 px, 768 px, 1024 px, and 1440 px layouts, and confirm search, role filters, favorites, dialog open/close, sticky tabs, anchors, and source links work with keyboard and touch.

- [ ] **Step 8: Run tests and commit**

Run: `npm test && npm run lint && npm run build:pages`

Expected: all commands pass.

```bash
git add app/page.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: redesign guide browsing from Hai Dau reference"
```

---

### Task 8: Final release verification and GitHub Pages deployment

**Files:**
- Modify: generated output only when required by the final verified build.

- [ ] **Step 1: Run the complete fresh verification suite**

Run: `npm run test:moderation && npm run validate:community && npm run lint && npm run build:pages && node --test tests/rendered-html.test.mjs`

Expected: every command exits 0.

- [ ] **Step 2: Verify the final static contract**

Confirm `out/.nojekyll`, no manifest/service worker/install CTA, no horizontal overflow at target widths, no curated/generated collision, and every CSS/JS reference resolves to an existing file.

- [ ] **Step 3: Fast-forward the approved branch to `main` and push**

Preserve the tested commit sequence and do not rewrite unrelated user history.

- [ ] **Step 4: Verify the public site**

Confirm `https://trannguyenbaoht2003-crypto.github.io/` returns HTTP 200, contains the new Hải Đấu-inspired Vietnamese interface and automatic-moderation copy, and every referenced CSS/JS asset returns HTTP 200.
