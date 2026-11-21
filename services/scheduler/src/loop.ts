import type { Logger } from '@monitorly/logger';

export interface Loop {
  /** Run the next iteration now instead of waiting for the interval. */
  wake(): void;
  /** Stop after the current iteration finishes. */
  stop(): Promise<void>;
}

/**
 * Runs `fn` repeatedly, waiting `intervalMs` between the end of one run and the start of the next
 * (runs never overlap). Errors are logged and the loop keeps going.
 * If `fn` returns true ("there's more work"), the next run starts immediately.
 */
export function startLoop(name: string, intervalMs: number, fn: () => Promise<boolean | void>, logger: Logger): Loop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let wakeUp: (() => void) | undefined;
  let consecutiveErrors = 0;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wakeUp = resolve;
      timer = setTimeout(resolve, ms);
    }).finally(() => {
      clearTimeout(timer);
      wakeUp = undefined;
    });

  const running = (async () => {
    while (!stopped) {
      let more = false;
      try {
        more = (await fn()) === true;
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        // Log the first failure loudly, then only every 10th, so an outage doesn't flood the logs.
        if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
          logger.error({ err, loop: name, consecutiveErrors }, 'Loop iteration failed');
        }
      }
      if (!stopped && !more) await sleep(intervalMs);
    }
  })();

  return {
    wake: () => wakeUp?.(),
    stop: async () => {
      stopped = true;
      wakeUp?.();
      await running;
    },
  };
}
