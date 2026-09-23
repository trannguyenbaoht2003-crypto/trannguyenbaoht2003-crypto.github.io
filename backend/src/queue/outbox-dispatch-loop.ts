export interface RunOutboxDispatchLoopOptions {
  dispatch: () => Promise<void | { claimed: number; failed?: number }>;
  onError?: (error: unknown) => void;
  signal: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  sleepMs: number;
  idleSleepMs?: number;
  activeGraceMs?: number;
  now?: () => number;
}

async function sleepWithAbort(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function runOutboxDispatchLoop(
  options: RunOutboxDispatchLoopOptions,
): Promise<void> {
  const sleep = options.sleep ?? sleepWithAbort;
  const now = options.now ?? (() => performance.now());
  let lastActivityAt = now();
  while (!options.signal.aborted) {
    let delay = options.sleepMs;
    try {
      const result = await options.dispatch();
      if (result && result.claimed > 0) lastActivityAt = now();
      if (result?.claimed === 0
        && now() - lastActivityAt >= (options.activeGraceMs ?? 60_000)) {
        delay = options.idleSleepMs ?? options.sleepMs;
      }
      if (result && (result.failed ?? 0) > 0) {
        delay = options.idleSleepMs ?? options.sleepMs;
      }
    } catch (error) {
      options.onError?.(error);
      delay = options.idleSleepMs ?? options.sleepMs;
    }
    if (options.signal.aborted) break;
    await sleep(delay, options.signal);
  }
}
