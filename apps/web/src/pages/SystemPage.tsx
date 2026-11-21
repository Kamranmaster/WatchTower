import { useMutation, useQuery } from '@tanstack/react-query';
import type { SchedulerStatusDto } from '@monitorly/contracts';
import { ApiError, api } from '../lib/api';

interface ReadyResponse {
  status: 'ok' | 'degraded';
  checks: Record<string, 'up' | 'down'>;
  uptimeSeconds: number;
}

interface QueueStats {
  queue: string;
  messageCount: number;
  consumerCount: number;
  deadLettered: number;
}

/** Readiness returns 503 with a JSON body when degraded — surface that body instead of failing. */
async function fetchReady(): Promise<ReadyResponse> {
  try {
    return await api<ReadyResponse>('/health/ready');
  } catch (err) {
    if (err instanceof ApiError && err.status === 503 && err.body) return err.body as unknown as ReadyResponse;
    throw err;
  }
}

/** Developer page: infrastructure health and RabbitMQ queue depths. */
export function SystemPage() {
  const ready = useQuery({ queryKey: ['health'], queryFn: fetchReady, refetchInterval: 5000 });
  const queues = useQuery({
    queryKey: ['queues'],
    queryFn: () => api<{ queues: QueueStats[] }>('/api/dev/queues'),
    refetchInterval: 2000,
  });
  const scheduler = useQuery({
    queryKey: ['scheduler'],
    queryFn: () => api<SchedulerStatusDto>('/api/dev/scheduler'),
    refetchInterval: 2000,
  });
  const testJob = useMutation({
    mutationFn: () => api<{ message: { messageId: string } }>('/api/dev/test-fetch-job', { method: 'POST', json: {} }),
    onSuccess: () => void queues.refetch(),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">System</h1>
        <p className="text-slate-500">Infrastructure health and message queues (development only).</p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold">System status</h2>
        {ready.isError ? (
          <p className="text-red-600">API unreachable — is <code>npm run dev:api</code> running?</p>
        ) : !ready.data ? (
          <p className="text-slate-500">Checking…</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatusPill label="API" up />
            {Object.entries(ready.data.checks).map(([name, state]) => (
              <StatusPill key={name} label={name} up={state === 'up'} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold">Scheduler</h2>
        {scheduler.isError ? (
          <p className="text-red-600">{scheduler.error.message}</p>
        ) : !scheduler.data ? (
          <p className="text-slate-500">Loading…</p>
        ) : (
          <SchedulerPanel data={scheduler.data} />
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">RabbitMQ queues</h2>
          <button
            type="button"
            onClick={() => testJob.mutate()}
            disabled={testJob.isPending}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {testJob.isPending ? 'Publishing…' : 'Send test fetch job'}
          </button>
        </div>
        {testJob.isSuccess && (
          <p className="mb-4 text-sm text-emerald-700">
            Published <code>{testJob.data.message.messageId}</code> — check the fetch-worker logs.
          </p>
        )}
        {testJob.isError && <p className="mb-4 text-sm text-red-600">{testJob.error.message}</p>}
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-1 font-medium">Queue</th>
              <th className="py-1 font-medium">Ready</th>
              <th className="py-1 font-medium">Consumers</th>
              <th className="py-1 font-medium">Dead-lettered</th>
            </tr>
          </thead>
          <tbody>
            {queues.data?.queues.map((q) => (
              <tr key={q.queue} className="border-t border-slate-100">
                <td className="py-2 font-mono">{q.queue}</td>
                <td className="py-2">{q.messageCount}</td>
                <td className={`py-2 ${q.consumerCount === 0 ? 'text-slate-400' : 'text-emerald-700'}`}>
                  {q.consumerCount}
                </td>
                <td className={`py-2 ${q.deadLettered > 0 ? 'text-red-600 font-semibold' : ''}`}>{q.deadLettered}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function StatusPill({ label, up }: { label: string; up: boolean }) {
  return (
    <li className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
      <span className={`h-2.5 w-2.5 rounded-full ${up ? 'bg-emerald-500' : 'bg-red-500'}`} />
      <span className="font-medium capitalize">{label}</span>
      <span className="ml-auto text-xs text-slate-500">{up ? 'up' : 'down'}</span>
    </li>
  );
}

function SchedulerPanel({ data }: { data: SchedulerStatusDto }) {
  const live = data.instances.filter((i) => Date.now() - Date.parse(i.lastSeenAt) < 30_000);
  return (
    <div className="space-y-4 text-sm">
      {live.length === 0 ? (
        <p className="text-amber-700">
          No scheduler running — start it with <code>npm run dev</code> (or <code>npm run dev:scheduler</code>).
        </p>
      ) : (
        <table className="w-full">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-1 font-medium">Instance</th>
              <th className="py-1 font-medium">Partitions</th>
              <th className="py-1 font-medium">Last heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {live.map((i) => (
              <tr key={i.id} className="border-t border-slate-100">
                <td className="py-2 font-mono">{i.id}</td>
                <td className="py-2">{i.partitions} / 64</td>
                <td className="py-2">{Math.round((Date.now() - Date.parse(i.lastSeenAt)) / 1000)} s ago</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.unownedPartitions > 0 && live.length > 0 && (
        <p className="text-amber-700">{data.unownedPartitions} partitions have no owner right now (rebalancing).</p>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Due monitors" value={data.dueMonitors} />
        <Stat label="Outbox pending" value={data.outbox.pending} warn={data.outbox.pending > 0} />
        <Stat label="Outbox failed" value={data.outbox.failed} bad={data.outbox.failed > 0} />
        <Stat label="Runs queued" value={data.checkRuns.queued} />
      </dl>
    </div>
  );
}

function Stat({ label, value, warn, bad }: { label: string; value: number; warn?: boolean; bad?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-lg font-semibold ${bad ? 'text-red-600' : warn ? 'text-amber-700' : ''}`}>{value}</dd>
    </div>
  );
}
