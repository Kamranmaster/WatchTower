import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CheckRunDto,
  EventListResponse,
  CreateMonitorInput,
  InterpretInstructionInput,
  InterpretInstructionResponse,
  MonitorDto,
  UpdateMonitorInput,
} from '@monitorly/contracts';
import { api } from '../lib/api';

const LIST_KEY = ['monitors'] as const;
const detailKey = (id: string) => ['monitors', id] as const;

export function useMonitors() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => (await api<{ monitors: MonitorDto[] }>('/api/monitors')).monitors,
    // Keep "next check"/"last checked" fresh once the scheduler runs.
    refetchInterval: 30_000,
  });
}

/** Recent check runs; refreshed often so queued → finished shows up without reloading. */
export function useMonitorRuns(id: string, limit = 10) {
  return useQuery({
    queryKey: ['monitors', id, 'runs', limit],
    queryFn: async () => (await api<{ runs: CheckRunDto[] }>(`/api/monitors/${id}/runs?limit=${limit}`)).runs,
    refetchInterval: 10_000,
    // "Show more" keeps the current rows on screen while the longer list loads.
    placeholderData: keepPreviousData,
  });
}

export type EventFilter = 'all' | 'matched';

const eventsUrl = (base: string, filter: EventFilter, limit: number, cursor: string | null) =>
  `${base}?limit=${limit}${filter === 'matched' ? '&only=matched' : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

/** Changes detected on one monitor, newest first, a page at a time ("Load older"). */
export function useMonitorEvents(id: string, filter: EventFilter = 'all', pageSize = 25) {
  return useInfiniteQuery({
    queryKey: ['monitors', id, 'events', filter],
    queryFn: ({ pageParam }) => api<EventListResponse>(eventsUrl(`/api/monitors/${id}/events`, filter, pageSize, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 15_000,
  });
}

/** Recent changes across all monitors (dashboard). onlyMatched: just the ones the user is alerted about. */
export function useRecentEvents(limit = 10, onlyMatched = false) {
  return useQuery({
    queryKey: ['events', limit, onlyMatched],
    queryFn: async () => (await api<EventListResponse>(eventsUrl('/api/events', onlyMatched ? 'matched' : 'all', limit, null))).events,
    refetchInterval: 15_000,
  });
}

export function useMonitor(id: string) {
  return useQuery({
    queryKey: detailKey(id),
    queryFn: async () => (await api<{ monitor: MonitorDto }>(`/api/monitors/${id}`)).monitor,
    refetchInterval: 30_000,
  });
}

/** After any change, put the fresh monitor in the detail cache and refresh the list. */
function useSyncMonitorCache() {
  const qc = useQueryClient();
  return (monitor: MonitorDto) => {
    qc.setQueryData(detailKey(monitor.id), monitor);
    qc.setQueryData<MonitorDto[]>(LIST_KEY, (list) => list?.map((m) => (m.id === monitor.id ? monitor : m)));
    void qc.invalidateQueries({ queryKey: LIST_KEY, exact: true });
  };
}

export function useCreateMonitor() {
  const sync = useSyncMonitorCache();
  return useMutation({
    mutationFn: async (input: CreateMonitorInput) =>
      (await api<{ monitor: MonitorDto }>('/api/monitors', { method: 'POST', json: input })).monitor,
    onSuccess: sync,
  });
}

export function useUpdateMonitor(id: string) {
  const sync = useSyncMonitorCache();
  return useMutation({
    mutationFn: async (input: UpdateMonitorInput) =>
      (await api<{ monitor: MonitorDto }>(`/api/monitors/${id}`, { method: 'PATCH', json: input })).monitor,
    onSuccess: sync,
  });
}

export function useSetMonitorPaused() {
  const sync = useSyncMonitorCache();
  return useMutation({
    mutationFn: async ({ id, paused }: { id: string; paused: boolean }) =>
      (await api<{ monitor: MonitorDto }>(`/api/monitors/${id}/${paused ? 'pause' : 'resume'}`, { method: 'POST' }))
        .monitor,
    onSuccess: sync,
  });
}

export function useDeleteMonitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/monitors/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: detailKey(id) });
      qc.setQueryData<MonitorDto[]>(LIST_KEY, (list) => list?.filter((m) => m.id !== id));
    },
  });
}

/** Natural language → proposed filters. Saves nothing; the user reviews the result first. */
export function useInterpretInstruction() {
  return useMutation({
    mutationFn: (input: InterpretInstructionInput) =>
      api<InterpretInstructionResponse>('/api/monitors/interpret', { method: 'POST', json: input }),
  });
}
