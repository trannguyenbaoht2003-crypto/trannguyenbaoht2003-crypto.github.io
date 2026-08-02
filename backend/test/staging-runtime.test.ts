import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const backendRoot = new URL('../', import.meta.url);

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, backendRoot), 'utf8');
}

test('staging runtime provides a one-shot migration CLI and locked backend image', async () => {
  const [packageSource, migrateCli, dockerfile, dockerignore] = await Promise.all([
    read('package.json'),
    read('src/migrate-cli.ts'),
    read('Dockerfile'),
    read('.dockerignore'),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.migrate, 'node dist/src/migrate-cli.js');
  assert.match(migrateCli, /new Pool\(\{ connectionString: config\.databaseUrl \}\)/);
  assert.match(migrateCli, /await migrate\(pool\)/);
  assert.match(migrateCli, /await pool\.end\(\)/);
  assert.match(migrateCli, /Migration failed/);

  assert.match(dockerfile, /FROM node:22\.13\.0-bookworm-slim AS build/);
  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["node", "dist\/src\/server\.js"\]/);
  assert.doesNotMatch(dockerfile, /DATABASE_URL|REDIS_URL|PASSWORD|TOKEN|PRIVATE KEY/);

  assert.match(dockerignore, /node_modules/);
  assert.match(dockerignore, /dist/);
  assert.match(dockerignore, /\.env/);
});
