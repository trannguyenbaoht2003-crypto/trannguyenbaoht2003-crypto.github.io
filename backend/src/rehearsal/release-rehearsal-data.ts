export function assertReleaseRehearsalEnabled(
  env: NodeJS.ProcessEnv,
): void {
  if (env.STAGING_REHEARSAL_ENABLED !== '1') {
    throw new Error('RELEASE_REHEARSAL_DISABLED');
  }
}
