import { MAX_ATTEMPTS, type FetchJob } from '@monitorly/contracts';
import {
  FetchError,
  assessContent,
  beginRun,
  escalateToBrowser,
  httpFetch,
  recordFailure,
  recordSuccess,
  type HttpFetchOptions,
  type PipelineDeps,
  type RobotsChecker,
} from '@monitorly/fetching';
import type { Logger } from '@monitorly/logger';
import type { ConsumeContext } from '@monitorly/messaging';

export interface HttpHandlerDeps {
  pipeline: PipelineDeps;
  logger: Logger;
  fetchOptions: HttpFetchOptions;
  /** Omit to skip robots.txt checks. */
  robots?: RobotsChecker;
}

/** "auto" mode escalates these to the browser: often bot protection that a real browser passes. */
const BOT_BLOCK_STATUSES = new Set([401, 403, 406]);

/**
 * One fetch.http job:
 *   robots.txt → SSRF-safe HTTP fetch → (auto mode) is the content usable? → store + publish reference.
 * Failures are recorded on the run; retryable ones are rethrown so the bus retries with backoff
 * (5 s, 30 s, 2 min). Anything unexpected (e.g. MongoDB down) is rethrown too.
 */
export async function handleHttpFetchJob(deps: HttpHandlerDeps, job: FetchJob, ctx: ConsumeContext): Promise<void> {
  const log = deps.logger.child({ checkRunId: job.checkRunId, monitorId: job.monitorId, attempt: ctx.attempt });
  const begun = await beginRun(job, ctx.attempt, { worker: 'http' });
  if (begun.kind === 'done') {
    log.info({ reason: begun.reason }, 'Nothing to do for this job');
    return;
  }
  const { monitor, run } = begun;
  const auto = monitor.fetchMode === 'auto';
  const started = Date.now();

  try {
    if (deps.robots && !(await deps.robots.isAllowed(job.url))) {
      throw new FetchError('robots', 'The site’s robots.txt does not allow automated access to this page');
    }

    const page = await httpFetch(job.url, deps.fetchOptions);

    if (auto) {
      const assessment = assessContent(page.body, page.contentType);
      if (!assessment.usable) {
        log.info({ reason: assessment.reason, textLength: assessment.textLength }, 'HTTP content not usable; escalating to browser');
        await escalateToBrowser(deps.pipeline, { job, run, reason: assessment.reason ?? 'no content' });
        return;
      }
    }

    const outcome = await recordSuccess(deps.pipeline, { job, monitor, run, page, fetchMode: 'http' });
    log.info({ status: page.status, bytes: page.bytes, ms: Date.now() - started, outcome }, 'Fetched');
  } catch (err) {
    if (!(err instanceof FetchError)) throw err;

    if (auto && err.kind === 'http_status' && BOT_BLOCK_STATUSES.has(err.status!)) {
      log.info({ status: err.status }, 'Blocked over HTTP; escalating to browser');
      await escalateToBrowser(deps.pipeline, { job, run, reason: `HTTP ${err.status}` });
      return;
    }

    const final = !err.retryable || ctx.attempt >= MAX_ATTEMPTS;
    await recordFailure(deps.pipeline, { run, monitor, error: err, attempt: ctx.attempt, final });
    log.warn({ kind: err.kind, status: err.status, final, msg: err.message }, 'Fetch failed');
    if (!final) throw err; // → retry queue with backoff
  }
}
