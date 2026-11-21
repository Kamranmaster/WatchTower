import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
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
