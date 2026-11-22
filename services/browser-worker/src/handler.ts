import { MAX_ATTEMPTS, type FetchJob } from '@monitorly/contracts';
import { FetchError, beginRun, recordFailure, recordSuccess, type PipelineDeps, type RobotsChecker } from '@monitorly/fetching';
import type { Logger } from '@monitorly/logger';
import type { ConsumeContext } from '@monitorly/messaging';
import type { BrowserFetcher } from './browser';

export interface BrowserHandlerDeps {
  pipeline: PipelineDeps;
  logger: Logger;
  browser: Pick<BrowserFetcher, 'fetch'>;
  robots?: RobotsChecker;
}

/** One fetch.browser job: robots.txt → render in Chromium (through the safety proxy) → store + publish reference. */
export async function handleBrowserFetchJob(deps: BrowserHandlerDeps, job: FetchJob, ctx: ConsumeContext): Promise<void> {
  const log = deps.logger.child({ checkRunId: job.checkRunId, monitorId: job.monitorId, attempt: ctx.attempt });
  const begun = await beginRun(job, ctx.attempt, { worker: 'browser' });
  if (begun.kind === 'done') {
    log.info({ reason: begun.reason }, 'Nothing to do for this job');
    return;
  }
  const { monitor, run } = begun;
  const started = Date.now();

  try {
    if (deps.robots && !(await deps.robots.isAllowed(job.url))) {
      throw new FetchError('robots', 'The site’s robots.txt does not allow automated access to this page');
    }
    const page = await deps.browser.fetch(job.url);
    const outcome = await recordSuccess(deps.pipeline, { job, monitor, run, page, fetchMode: 'browser' });
    log.info({ status: page.status, bytes: page.bytes, ms: Date.now() - started, outcome }, 'Rendered');
  } catch (err) {
    if (!(err instanceof FetchError)) throw err;
    const final = !err.retryable || ctx.attempt >= MAX_ATTEMPTS;
    await recordFailure(deps.pipeline, { run, monitor, error: err, attempt: ctx.attempt, final });
    log.warn({ kind: err.kind, status: err.status, final, msg: err.message }, 'Browser fetch failed');
    if (!final) throw err;
  }
}
