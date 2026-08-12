import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const baseUrl = (process.env.RELEASE_E2E_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const composeArgs = [
  'compose',
  '--env-file', 'deploy/staging/.env.example',
  '-f', 'deploy/staging/compose.yml',
];

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error('RELEASE_SECURITY_COMMAND_FAILED');
  }
  return result;
}

function compose(args, options) {
  return run('docker', [...composeArgs, ...args], options);
}

function requireNonRoot(service) {
  const id = compose(['ps', '-q', service]).stdout.trim();
  assert.ok(id, `${service} container must be running`);
  const user = run('docker', ['inspect', '--format', '{{.Config.User}}', id]).stdout.trim();
  assert.ok(user, `${service} final image must declare a non-root user`);
  assert.notEqual(user, '0');
  assert.notEqual(user.toLowerCase(), 'root');
  return user;
}

function blockedAuditPackages(auditBody) {
  return Object.entries(auditBody?.vulnerabilities ?? {})
    .filter(([, finding]) => finding?.severity === 'high' || finding?.severity === 'critical')
    .map(([packageName]) => packageName)
    .filter((packageName) => /^[A-Za-z0-9@/._-]+$/.test(packageName))
    .sort()
    .slice(0, 10);
}

const configuration = JSON.parse(compose(['config', '--format', 'json']).stdout);
const services = configuration.services ?? {};
assert.ok(services.gateway, 'gateway service must exist');
assert.ok(!services.worker, 'default staging topology must not start a worker');

const servicesWithPublishedPorts = Object.entries(services)
  .filter(([, service]) => Array.isArray(service.ports) && service.ports.length > 0)
  .map(([name]) => name);
assert.deepEqual(servicesWithPublishedPorts, ['gateway']);

const backendUser = requireNonRoot('backend');
const gatewayUser = requireNonRoot('gateway');

const nodeProbe = compose([
  'exec', '-T', 'gateway', 'sh', '-lc',
  'command -v node >/dev/null 2>&1',
], { allowFailure: true });
assert.notEqual(nodeProbe.status, 0, 'gateway runtime must not ship Node/Next');

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const response = await fetch(`${baseUrl}/api/v1/publications`, {
    method,
    headers: { Accept: 'application/json' },
    credentials: 'omit',
  });
  assert.ok(
    response.status === 404 || response.status === 405,
    `${method} Publication mutation route must remain unavailable`,
  );
}

const audit = run('npm', ['--prefix', 'backend', 'audit', '--omit=dev', '--json'], {
  allowFailure: true,
});
let auditBody;
try {
  auditBody = JSON.parse(audit.stdout);
} catch {
  throw new Error('BACKEND_RUNTIME_AUDIT_OUTPUT_INVALID');
}
const vulnerabilityCounts = auditBody?.metadata?.vulnerabilities ?? {};
const high = Number(vulnerabilityCounts.high ?? 0);
const critical = Number(vulnerabilityCounts.critical ?? 0);
if (high > 0 || critical > 0) {
  const packages = blockedAuditPackages(auditBody);
  const packageSummary = packages.length > 0 ? packages.join(',') : 'unknown';
  throw new Error(
    `BACKEND_RUNTIME_AUDIT_BLOCKED:high=${high}:critical=${critical}:packages=${packageSummary}`,
  );
}

const secretPattern = [
  'ghp_', '[A-Za-z0-9]{30,}', '|',
  'AKIA', '[0-9A-Z]{16}', '|',
  '-----BEGIN ', '(RSA|EC|OPENSSH)', ' PRIVATE KEY-----',
].join('');
const secretProbe = run('git', [
  'grep', '-n', '-E', secretPattern, '--',
  ':!package-lock.json', ':!backend/package-lock.json',
], { allowFailure: true });
if (secretProbe.status === 0) {
  const findingCount = secretProbe.stdout.split(/\r?\n/).filter(Boolean).length;
  throw new Error(`RELEASE_SECRET_PATTERN_BLOCKED:count=${findingCount}`);
}
assert.equal(secretProbe.status, 1, 'secret pattern scan must complete normally');

console.log(`release-security: non-root backend=${backendUser} gateway=${gatewayUser} PASS`);
console.log('release-security: single public port, read-only HTTP, runtime and secret gates PASS');
