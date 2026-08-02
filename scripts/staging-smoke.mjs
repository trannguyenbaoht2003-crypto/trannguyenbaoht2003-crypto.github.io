const allowedModes = new Set(["normal", "backend-down", "recovered"]);
const mode = process.argv[2] ?? "normal";

if (!allowedModes.has(mode)) {
  process.stderr.write("Smoke failed: unsupported mode\n");
  process.exit(1);
}

const configuredBase = process.env.STAGING_BASE_URL?.trim() || "http://127.0.0.1:8080";
let baseUrl;
try {
  baseUrl = new URL(configuredBase);
} catch {
  process.stderr.write("Smoke failed: STAGING_BASE_URL is invalid\n");
  process.exit(1);
}

if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
  process.stderr.write("Smoke failed: STAGING_BASE_URL is invalid\n");
  process.exit(1);
}

function endpoint(pathname) {
  return new URL(pathname, `${baseUrl.toString().replace(/\/+$/, "")}/`);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, init) {
  let response;
  try {
    response = await fetch(endpoint(pathname), {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`${pathname} request failed`);
  }
  process.stdout.write(`${pathname} ${response.status}\n`);
  return response;
}

async function readJson(response, pathname) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${pathname} returned invalid JSON`);
  }
}

async function verifyRoot() {
  const response = await request("/");
  ensure(response.status === 200, "/ expected 200");
  const html = await response.text();
  ensure(html.includes("Lõi.Meta"), "/ missing static application marker");
}

async function verifyHealthyReadPath() {
  const live = await request("/health/live");
  ensure(live.status === 200, "/health/live expected 200");
  const livePayload = await readJson(live, "/health/live");
  ensure(livePayload?.status === "live", "/health/live envelope mismatch");

  const ready = await request("/health/ready");
  ensure(ready.status === 200, "/health/ready expected 200");
  const readyPayload = await readJson(ready, "/health/ready");
  ensure(readyPayload?.status === "ready", "/health/ready envelope mismatch");

  const publications = await request("/api/v1/publications", {
    headers: { accept: "application/json" },
  });
  ensure(publications.status === 200, "/api/v1/publications expected 200");
  const publicationPayload = await readJson(publications, "/api/v1/publications");
  ensure(publicationPayload?.schemaVersion === 1, "Publication schema version mismatch");
  ensure(Array.isArray(publicationPayload?.publications), "Publication list envelope mismatch");
  ensure(
    JSON.stringify(Object.keys(publicationPayload).sort()) === JSON.stringify(["publications", "schemaVersion"]),
    "Publication list envelope is not closed",
  );

  const mutationProbe = await request("/api/v1/publications", {
    method: "POST",
    headers: { accept: "application/json" },
  });
  ensure([404, 405].includes(mutationProbe.status), "Publication mutation route unexpectedly exists");
}

async function verifyBackendOutage() {
  const publications = await request("/api/v1/publications", {
    headers: { accept: "application/json" },
  });
  ensure(publications.status >= 500 && publications.status < 600, "API expected a gateway 5xx");
}

try {
  await verifyRoot();
  if (mode === "backend-down") {
    await verifyBackendOutage();
  } else {
    await verifyHealthyReadPath();
  }
  process.stdout.write(`staging-smoke ${mode} PASS\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown smoke failure";
  process.stderr.write(`Smoke failed: ${message}\n`);
  process.exit(1);
}
