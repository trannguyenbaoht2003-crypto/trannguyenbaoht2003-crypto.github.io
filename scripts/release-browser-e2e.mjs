import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const baseUrl = (process.env.RELEASE_E2E_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const expected = process.env.RELEASE_E2E_EXPECT ?? 'v1';
const allowed = new Set(['v1', 'v2', 'backend-down', 'recovered-v1']);

if (!allowed.has(expected)) {
  throw new Error('RELEASE_E2E_EXPECT_INVALID');
}

function findBrowser() {
  for (const executable of ['google-chrome', 'chromium', 'chromium-browser']) {
    const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return executable;
  }
  throw new Error('RELEASE_BROWSER_NOT_AVAILABLE');
}

async function readActivePublication() {
  const response = await fetch(`${baseUrl}/api/v1/publications`, {
    headers: { Accept: 'application/json' },
    credentials: 'omit',
  });
  if (!response.ok) {
    throw new Error(`RELEASE_PUBLICATION_READ_FAILED:${response.status}`);
  }
  const body = await response.json();
  assert.equal(body?.schemaVersion, 1);
  assert.ok(Array.isArray(body?.publications));
  const publication = body.publications.find(
    (entry) => entry?.payload?.championExternalId === 'samira',
  );
  assert.ok(publication, 'Samira rehearsal Publication must be publicly readable');
  return publication;
}

function dumpHydratedDom() {
  const browser = findBrowser();
  const result = spawnSync(browser, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--virtual-time-budget=8000',
    '--dump-dom',
    `${baseUrl}/`,
  ], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error('RELEASE_BROWSER_RENDER_FAILED');
  }
  return result.stdout;
}

if (expected === 'backend-down') {
  const response = await fetch(`${baseUrl}/api/v1/publications`);
  assert.ok(response.status >= 500, `backend-down API must fail closed, got ${response.status}`);
  const dom = dumpHydratedDom();
  assert.match(dom, /Lõi<span>\.Meta<\/span>|Lõi\.Meta/);
  assert.match(dom, /Samira/);
  assert.match(dom, /public-data-status fallback/);
  assert.match(dom, /API tạm thời không khả dụng/);
  assert.doesNotMatch(dom, /8d000000-/);
  console.log('release-browser: backend-down static fallback PASS');
} else {
  const publication = await readActivePublication();
  const expectedVersion = expected === 'v2' ? 2 : 1;
  assert.equal(publication.versionNumber, expectedVersion);
  assert.equal(publication.payload.mode, 'aram_mayhem');
  assert.equal(publication.payload.championExternalId, 'samira');
  assert.deepEqual(publication.payload.augmentExternalIds, ['1194']);
  assert.deepEqual(publication.payload.itemExternalIds, ['3006', '6672']);

  const dom = dumpHydratedDom();
  assert.match(dom, /Lõi<span>\.Meta<\/span>|Lõi\.Meta/);
  assert.match(dom, /Samira/);
  assert.match(dom, /public-data-status live/);
  assert.match(dom, /Bản đã xuất bản|bản đã xuất bản/i);
  assert.doesNotMatch(dom, /8d000000-/);
  console.log(`release-browser: ${expected} version ${expectedVersion} PASS`);
}
