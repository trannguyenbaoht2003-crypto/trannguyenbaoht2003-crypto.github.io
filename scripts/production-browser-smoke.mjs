import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const rawBase = process.env.PRODUCTION_BASE_URL?.trim();
if (!rawBase) throw new Error('PRODUCTION_BASE_URL_REQUIRED');

let url;
try {
  url = new URL(rawBase);
} catch {
  throw new Error('PRODUCTION_BASE_URL_INVALID');
}

const localHost = new Set(['127.0.0.1', 'localhost', '[::1]']);
const allowLocal = process.env.PRODUCTION_SMOKE_ALLOW_LOCAL === '1';
if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && localHost.has(url.hostname))) {
  throw new Error('PRODUCTION_BASE_URL_MUST_BE_HTTPS');
}

const origin = url.toString().replace(/\/$/, '');

function findBrowser() {
  for (const executable of ['google-chrome', 'chromium', 'chromium-browser']) {
    const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return executable;
  }
  throw new Error('PRODUCTION_BROWSER_NOT_AVAILABLE');
}

const browser = findBrowser();
const result = spawnSync(browser, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--virtual-time-budget=8000',
  '--dump-dom',
  `${origin}/`,
], {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});

if (result.status !== 0) throw new Error('PRODUCTION_BROWSER_RENDER_FAILED');

const dom = result.stdout;
assert.match(dom, /LÕI<span>\.META<\/span>|LÕI\.META/i);
assert.match(dom, /Samira/);
assert.match(dom, /public-data-status (?:static|live|fallback)/);
assert.doesNotMatch(dom, /8d000000-/);
console.log('production-browser-smoke: PASS');
