import type { Logger } from '@monitorly/logger';

export interface ServiceHandle {
  /** Release resources: stop consumers, finish in-flight work, close connections. */
  stop: () => Promise<void>;
}

export interface ServiceContext {
  /** Call when a dependency is lost for good; triggers a clean shutdown with exit code 1. */
  fail: (reason: string, err?: unknown) => void;
}

const SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * Runs a long-lived service with consistent lifecycle handling:
 * SIGINT/SIGTERM → graceful stop; crash or lost dependency → stop and exit 1
 * so Docker/the orchestrator restarts the process cleanly.
 */
export function runService(
  logger: Logger,
  start: (ctx: ServiceContext) => Promise<ServiceHandle>,
): void {
  let handle: ServiceHandle | undefined;
  let stopping = false;

  const stop = async (reason: string, exitCode: number) => {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, 'Shutting down');
    const timer = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    try {
      await handle?.stop();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      exitCode = 1;
    }
    clearTimeout(timer);
    logger.info('Stopped');
    // Give the async log transport a moment to flush.
    setTimeout(() => process.exit(exitCode), 100);
  };

  const fail = (reason: string, err?: unknown) => {
    logger.fatal({ err }, reason);
    void stop(reason, 1);
  };

  process.once('SIGINT', () => void stop('SIGINT', 0));
  process.once('SIGTERM', () => void stop('SIGTERM', 0));
  process.on('unhandledRejection', (err) => fail('Unhandled promise rejection', err));
  process.on('uncaughtException', (err) => fail('Uncaught exception', err));

  start({ fail })
    .then((h) => {
      handle = h;
      if (stopping) void h.stop();
    })
    .catch((err) => fail('Failed to start', err));
}
