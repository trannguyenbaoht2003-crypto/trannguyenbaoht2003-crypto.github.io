import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('operator runtime composes PostgreSQL-only loopback server and dedicated scripts', async () => {
  const [source, packageText] = await Promise.all([
    read('src/operator-server.ts'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageText) as {
    scripts?: Record<string, string>;
  };

  assert.match(source, /parseOperatorConfig/);
  assert.match(source, /new Pool\s*\(/);
  assert.match(source, /buildOperatorApp/);
  assert.match(source, /readOperatorPublicationSignals/);
  assert.match(source, /select 1/i);
  assert.match(
    source,
    /app\.listen\s*\(\s*\{\s*host:\s*config\.host,\s*port:\s*config\.port\s*\}\s*\)/s,
  );
  assert.match(source, /SIGINT/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /pool\.end\s*\(/);

  assert.doesNotMatch(source, /ioredis|bullmq|Redis|Queue|Worker/);
  assert.doesNotMatch(source, /from ['"]\.\/server\.js['"]/);
  assert.doesNotMatch(source, /feedbackFingerprintSecret|REDIS_URL|redisUrl/);
  assert.doesNotMatch(source, /error\.message|String\(error\)|console\.error\(error/);

  assert.equal(
    packageJson.scripts?.['operator:dev'],
    'node --import tsx src/operator-server.ts',
  );
  assert.equal(
    packageJson.scripts?.operator,
    'node dist/src/operator-server.js',
  );
});
