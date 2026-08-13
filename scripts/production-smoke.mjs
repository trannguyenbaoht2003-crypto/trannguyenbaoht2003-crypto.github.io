import assert from 'node:assert/strict';

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

async function get(path, label) {
  const response = await fetch(`${origin}${path}`, {
    headers: { Accept: path === '/' ? 'text/html' : 'application/json' },
    redirect: 'error',
  });
  assert.equal(response.status, 200, `${label} expected 200, got ${response.status}`);
  console.log(`production-smoke: ${label} ${response.status}`);
  return response;
}

await get('/', 'root');
await get('/health/live', 'live');
await get('/health/ready', 'ready');

const publicationResponse = await get('/api/v1/publications', 'publications');
const publicationBody = await publicationResponse.json();
assert.equal(publicationBody?.schemaVersion, 1, 'Publication envelope schemaVersion must be 1');
assert.ok(Array.isArray(publicationBody?.publications), 'Publication envelope must contain publications array');
console.log(`production-smoke: publications schema=1 count=${publicationBody.publications.length}`);

const mutationResponse = await fetch(`${origin}/api/v1/publications`, {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: '{}',
  redirect: 'error',
});
assert.ok(
  mutationResponse.status === 404 || mutationResponse.status === 405,
  `Publication mutation route must be absent, got ${mutationResponse.status}`,
);
console.log(`production-smoke: mutation rejected ${mutationResponse.status}`);
console.log('production-smoke: PASS');
