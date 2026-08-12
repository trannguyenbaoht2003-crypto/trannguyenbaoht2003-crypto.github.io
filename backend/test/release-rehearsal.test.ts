import assert from 'node:assert/strict';
import { test } from 'node:test';

test('release rehearsal fails closed without explicit staging enablement', async () => {
  let rehearsal: {
    assertReleaseRehearsalEnabled?: (env: NodeJS.ProcessEnv) => void;
  };

  try {
    rehearsal = await import('../src/rehearsal/release-rehearsal-data.js');
  } catch (error) {
    assert.fail(
      `release rehearsal module must exist before this contract can pass: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  assert.equal(
    typeof rehearsal.assertReleaseRehearsalEnabled,
    'function',
    'release rehearsal must export assertReleaseRehearsalEnabled',
  );
  assert.throws(
    () => rehearsal.assertReleaseRehearsalEnabled?.({}),
    /RELEASE_REHEARSAL_DISABLED/,
  );
});
