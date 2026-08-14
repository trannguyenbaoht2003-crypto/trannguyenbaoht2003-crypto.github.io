export interface RunOutboxDispatchLoopOptions {
  dispatch: () => Promise<void>;
  onError?: (error: unknown) => void;
  signal: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  sleepMs: number;
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
  while (!options.signal.aborted) {
    try {
      await options.dispatch();
    } catch (error) {
      options.onError?.(error);
    }
    if (options.signal.aborted) break;
    await sleep(options.sleepMs, options.signal);
  }
}