import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import type { NotificationDto, NotificationListResponse } from '@monitorly/contracts';
import { api } from '../lib/api';

const KEY = ['notifications'] as const;

export function useNotifications(limit = 15) {
  return useQuery({
    queryKey: [...KEY, limit],
    queryFn: () => api<NotificationListResponse>(`/api/notifications?limit=${limit}`),
    // Live updates arrive over the socket; this is only the fallback if it's down.
    refetchInterval: 60_000,
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ notification: NotificationDto }>(`/api/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ updated: number }>('/api/notifications/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * Live updates over Socket.IO while logged in. The session cookie authenticates the socket.
 * On every (re)connect the list is refetched, so nothing is missed while offline.
 */
export function useLiveUpdates(userId: string | undefined, onNotification: (n: NotificationDto) => void) {
  const qc = useQueryClient();
  const handler = useRef(onNotification);
  handler.current = onNotification;

  useEffect(() => {
    if (!userId) return;
    const socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket'] });
    socket.on('connect', () => void qc.invalidateQueries({ queryKey: KEY }));
    socket.on('notification', (n: NotificationDto) => {
      void qc.invalidateQueries({ queryKey: KEY });
      // The change lists and "Changed … ago" are now stale too.
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: ['monitors'] });
      handler.current(n);
    });
    return () => {
      socket.disconnect();
    };
  }, [userId, qc]);
}
