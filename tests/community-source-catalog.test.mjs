import assert from "node:assert/strict";
import { cp, mkdir, readFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const moduleUrl = new URL("../scripts/lib/community-source-catalog.mjs", import.meta.url);
const catalogUrl = new URL("../app/chinese-meta-source-catalog.json", import.meta.url);
const root = new URL("../", import.meta.url);

async function load() {
  const api = await import(moduleUrl);
  const catalog = JSON.parse(await readFile(catalogUrl, "utf8"));
  return { ...api, catalog };
}

test("Chinese player queries run before reference sites without duplicating legacy queries", async () => {
  const { catalog, buildDiscoveryQueries } = await load();
  const queries = buildDiscoveryQueries(catalog, [{ id: "legacy", adapter: "bing-rss", platform: "Web", query: "other", maxResults: 4 }]);
  assert.equal(queries[0].platform, "Bilibili");
  assert.ok(queries.some((query) => query.query.includes("黑科技")));
  assert.ok(queries.some((query) => query.query.includes("冷门")));
  assert.ok(queries.some((query) => query.query.includes("联动")));
  assert.equal(queries.at(-1).id, "legacy");
  assert.equal(new Set(queries.map(({ id }) => id)).size, queries.length);
  assert.equal(buildDiscoveryQueries(catalog, queries).length, queries.length);
});

test("source matching requires HTTPS and an exact approved host boundary", async () => {
  const { catalog, sourceForUrl } = await load();
  assert.equal(sourceForUrl(catalog, "https://www.bilibili.com/video/BV1k1sozLEBB/")?.id, "bilibili-players");
  for (const url of ["http://www.bilibili.com/video/x", "https://bilibili.com.attacker.test/x", "https://evilbilibili.com/x", "https://a@www.bilibili.com/x", "https://www.bilibili.com:444/x", "file:///tmp/x"]) {
    assert.equal(sourceForUrl(catalog, url), undefined, url);
  }
});

test("source catalog rejects duplicate identities and executable or malformed discovery entries", async () => {
  const { catalog, validateSourceCatalog } = await load();
  assert.doesNotThrow(() => validateSourceCatalog(catalog));
  const duplicate = structuredClone(catalog);
  duplicate.sources.push(duplicate.sources[0]);
  assert.throws(() => validateSourceCatalog(duplicate), /DUPLICATE/);
  const unsafe = structuredClone(catalog);
  unsafe.sources[0].entryUrls[0] = "javascript:alert(1)";
  assert.throws(() => validateSourceCatalog(unsafe), /URL/);
  const broken = structuredClone(catalog);
  broken.sources[0].queries[0].maxResults = 10000;
  assert.throws(() => validateSourceCatalog(broken), /QUERY/);
});

test("freshness needs a dated source and explicit matching patch, including Riot label aliases", async () => {
  const { assessSourceEvidence } = await load();
  const base = { text: "海克斯大乱斗 26.18 黑科技 联动", publishedAt: "2026-09-11", currentPatch: "16.18", now: new Date("2026-09-12T10:00:00Z"), lookbackDays: 21 };
  const accepted = assessSourceEvidence(base);
  assert.equal(accepted.currentEnough, true);
  assert.equal(accepted.patchHint, "26.18");
  assert.equal(accepted.modeValid, true);
  assert.deepEqual(accepted.noveltySignals, ["黑科技", "联动"]);
  for (const [change, reason] of [
    [{ text: "海克斯大乱斗 16.14" }, "PATCH_MISMATCH"],
    [{ text: "海克斯大乱斗 黑科技" }, "PATCH_NOT_CONFIRMED"],
    [{ text: "海克斯大乱斗 16.14 26.18" }, "PATCH_AMBIGUOUS"],
    [{ publishedAt: undefined }, "PUBLISHED_AT_NOT_CONFIRMED"],
    [{ publishedAt: "2026-02-30" }, "PUBLISHED_AT_NOT_CONFIRMED"],
    [{ publishedAt: "2026-09-13" }, "SOURCE_FUTURE_DATED"],
    [{ publishedAt: "2026-08-01" }, "SOURCE_STALE"],
  ]) {
    const result = assessSourceEvidence({ ...base, ...change });
    assert.equal(result.currentEnough, false, reason);
    assert.ok(result.holdReasons.includes(reason), reason);
  }
});

test("Arena and CHERRY evidence cannot establish Mayhem mode, even in mixed posts", async () => {
  const { assessSourceEvidence } = await load();
  for (const text of ["CHERRY 16.18", "海克斯大乱斗 16.18 斗魂竞技场", "海克斯大乱斗 16.18 Arena", "普通大乱斗 16.18"]) {
    assert.equal(assessSourceEvidence({ text, currentPatch: "16.18", publishedAt: "2026-09-11", now: new Date("2026-09-12") }).modeValid, false, text);
  }
});

test("collector resolves the live patch from a valid Data Dragon release without using stale guides", async () => {
  const { resolveCurrentPatch } = await load();
  const result = await resolveCurrentPatch(async (url) => {
    assert.equal(url, "https://ddragon.leagueoflegends.com/api/versions.json");
    return ["16.18.1", "16.17.1"];
  });
  assert.equal(result, "16.18");
  await assert.rejects(() => resolveCurrentPatch(async () => ["latest"]), /PATCH_RELEASE_INVALID/);
  await assert.rejects(() => resolveCurrentPatch(async () => { throw new Error("offline"); }), /offline/);
});

test("offline collector replay persists provenance and holds old or unknown-patch player posts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hai-dau-zh-cn-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const today = new Date().toISOString().slice(0, 10);
    const rows = [
      { url: "https://www.bilibili.com/video/BV1k1sozLEBB/", title: "海克斯大乱斗 26.18 黑科技", publishedAt: today, platform: "Bilibili" },
      { url: "https://www.bilibili.com/video/BV1h7fdBsE5x/", title: "海克斯大乱斗 16.14 联动", publishedAt: today, platform: "Bilibili" },
      { url: "https://apexlol.info/zh/hextech", title: "海克斯大乱斗 冷门", platform: "Web Trung Quốc" },
      { url: "https://evilbilibili.com/video/x", title: "海克斯大乱斗 16.18", publishedAt: today, platform: "Bilibili" },
    ];
    const input = path.join(dir, "input.json");
    await writeFile(input, JSON.stringify(rows));
    execFileSync(process.execPath, ["scripts/collect-community-candidates.mjs", "--offline", "--input", input, "--current-patch", "16.18", "--output-dir", dir], { cwd: root, timeout: 15000, stdio: "pipe" });
    const inbox = JSON.parse(await readFile(path.join(dir, "community-inbox.json"), "utf8"));
    assert.equal(inbox.candidates.length, 3);
    const byUrl = new Map(inbox.candidates.map((row) => [row.url, row]));
    const current = byUrl.get(rows[0].url);
    assert.equal(current.sourceCatalogId, "bilibili-players");
    assert.equal(current.currentEnough, true);
    assert.deepEqual(current.noveltySignals, ["黑科技"]);
    assert.equal(byUrl.get(rows[1].url).currentEnough, false);
    assert.equal(byUrl.get(rows[1].url).patchHint, "16.14");
    assert.equal(byUrl.get(rows[2].url).currentEnough, false);
    const report = JSON.parse(await readFile(path.join(dir, "community-watch-report.json"), "utf8"));
    assert.equal(report.currentPatch, "16.18");
    assert.equal(report.collectionMode, "offline");
    assert.equal(inbox.collectionMode, "offline");
    assert.equal(report.sourceCatalog.schemaVersion, 1);
    assert.equal(report.sourceCatalog.rejectedUrlCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("offline replay requires a separate output directory", () => {
  for (const extra of [[], ["--output-dir", "."], ["--output-dir", "data"]]) {
    assert.throws(() => execFileSync(process.execPath, ["scripts/collect-community-candidates.mjs", "--offline", "--input", "/tmp/unused.json", "--current-patch", "16.18", ...extra], { cwd: root, timeout: 5000, stdio: "pipe" }), (error) => {
      assert.match(String(error.stderr), /--output-dir/);
      return true;
    });
  }
});

test("offline replay rejects directory and file symlinks before touching live data", async (t) => {
  for (const linkKind of ["directory", "inbox", "report"]) {
    await t.test(linkKind, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "hai-dau-isolation-"));
      try {
        await mkdir(path.join(dir, "scripts"));
        await cp(new URL("scripts/lib", root), path.join(dir, "scripts/lib"), { recursive: true });
        await cp(new URL("scripts/collect-community-candidates.mjs", root), path.join(dir, "scripts/collect-community-candidates.mjs"));
        await mkdir(path.join(dir, "app"));
        for (const file of ["community-source-registry.json", "chinese-meta-source-catalog.json", "community-sources.json", "generated-guides.ts"]) {
          await cp(new URL(`app/${file}`, root), path.join(dir, "app", file));
        }
        await mkdir(path.join(dir, "data"));
        await cp(new URL("data/community-review-overrides.json", root), path.join(dir, "data/community-review-overrides.json"));
        const liveInbox = path.join(dir, "data/community-inbox.json");
        const liveReport = path.join(dir, "community-watch-report.json");
        const inboxText = JSON.stringify({ schemaVersion: 1, collectionMode: "live", candidates: [] });
        const reportText = JSON.stringify({ collectionMode: "live", currentPatch: "16.18" });
        await writeFile(liveInbox, inboxText);
        await writeFile(liveReport, reportText);
        const input = path.join(dir, "input.json");
        await writeFile(input, "[]");
        const output = path.join(dir, "replay");
        if (linkKind === "directory") {
          await symlink(path.join(dir, "data"), output, "dir");
        } else {
          await mkdir(output);
          await symlink(linkKind === "inbox" ? liveInbox : liveReport, path.join(output, linkKind === "inbox" ? "community-inbox.json" : "community-watch-report.json"));
        }
        assert.throws(() => execFileSync(process.execPath, ["scripts/collect-community-candidates.mjs", "--offline", "--input", input, "--current-patch", "16.18", "--output-dir", output], { cwd: dir, timeout: 5000, stdio: "pipe" }), (error) => {
          assert.match(String(error.stderr), /--output-dir/);
          return true;
        });
        assert.equal(await readFile(liveInbox, "utf8"), inboxText);
        assert.equal(await readFile(liveReport, "utf8"), reportText);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("legacy moderation consumes the live collector patch and rejects offline or old reports", async () => {
  const { collectorReportPatch } = await load();
  assert.equal(collectorReportPatch({ collectionMode: "live", currentPatch: "16.18" }), "16.18");
  for (const report of [{ currentPatch: "16.14" }, { collectionMode: "offline", currentPatch: "16.18" }]) {
    assert.throws(() => collectorReportPatch(report), /COLLECTOR_REPORT_NOT_LIVE/);
  }
});

test("a retained post keeps mode confirmation from its original non-title evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hai-dau-retained-"));
  const { writeFile } = await import("node:fs/promises");
  const input = path.join(dir, "input.json");
  const args = ["scripts/collect-community-candidates.mjs", "--offline", "--input", input, "--current-patch", "16.18", "--output-dir", dir];
  try {
    await writeFile(input, JSON.stringify([{ url: "https://www.bilibili.com/video/BV1k1sozLEBB/", title: "黑科技 亚托克斯", description: "海克斯大乱斗 26.18 联动", publishedAt: new Date().toISOString().slice(0, 10), platform: "Bilibili" }]));
    execFileSync(process.execPath, args, { cwd: root, timeout: 5000, stdio: "pipe" });
    await writeFile(input, "[]");
    execFileSync(process.execPath, args, { cwd: root, timeout: 5000, stdio: "pipe" });
    const inbox = JSON.parse(await readFile(path.join(dir, "community-inbox.json"), "utf8"));
    assert.equal(inbox.candidates[0].modeValid, true);
    assert.equal(inbox.candidates[0].currentEnough, true);
    assert.deepEqual(inbox.candidates[0].holdReasons, []);
    const nextPatchArgs = args.map((value) => value === "16.18" ? "16.19" : value);
    execFileSync(process.execPath, nextPatchArgs, { cwd: root, timeout: 5000, stdio: "pipe" });
    const expired = JSON.parse(await readFile(path.join(dir, "community-inbox.json"), "utf8"));
    assert.equal(expired.candidates[0].currentEnough, false);
    assert.ok(expired.candidates[0].holdReasons.includes("PATCH_MISMATCH"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit excluded modes invalidate retained legacy mode confirmation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hai-dau-retained-excluded-"));
  const input = path.join(dir, "input.json");
  const inboxPath = path.join(dir, "community-inbox.json");
  const args = ["scripts/collect-community-candidates.mjs", "--offline", "--input", input, "--current-patch", "16.18", "--output-dir", dir];
  try {
    await writeFile(input, JSON.stringify([{ url: "https://www.bilibili.com/video/BV1k1sozLEBB/", title: "海克斯大乱斗 16.18 黑科技", publishedAt: new Date().toISOString().slice(0, 10), platform: "Bilibili" }]));
    execFileSync(process.execPath, args, { cwd: root, timeout: 5000, stdio: "pipe" });
    const original = JSON.parse(await readFile(inboxPath, "utf8"));
    await writeFile(input, "[]");
    for (const excluded of ["Arena", "CHERRY", "斗魂竞技场"]) {
      const legacy = structuredClone(original);
      legacy.candidates[0].title = `海克斯大乱斗 16.18 ${excluded}`;
      delete legacy.candidates[0].holdReasons;
      await writeFile(inboxPath, JSON.stringify(legacy));
      execFileSync(process.execPath, args, { cwd: root, timeout: 5000, stdio: "pipe" });
      const retained = JSON.parse(await readFile(inboxPath, "utf8")).candidates[0];
      assert.equal(retained.modeValid, false, excluded);
      assert.equal(retained.currentEnough, false, excluded);
      assert.ok(retained.holdReasons.includes("MODE_EXCLUDED"), excluded);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
