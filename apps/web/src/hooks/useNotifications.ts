import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { io } from 'socket.io-client';
import type { NotificationDto, NotificationListResponse } from '@monitorly/contracts';
import { api } from '../lib/api';

const KEY = ['notifications'] as const;

/** Latest notifications + the unread count (the bell, the dashboard). */
export function useNotifications(limit = 15) {
  return useQuery({
    queryKey: [...KEY, 'latest', limit],
    queryFn: () => api<NotificationListResponse>(`/api/notifications?limit=${limit}`),
    // Live updates arrive over the socket; this is only the fallback if it's down.
    refetchInterval: 60_000,
  });
}

/** The full history on the notifications page, a page at a time. */
export function useNotificationHistory(unreadOnly: boolean, pageSize = 20) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'history', unreadOnly],
    queryFn: ({ pageParam }) =>
      api<NotificationListResponse>(
        `/api/notifications?limit=${pageSize}${unreadOnly ? '&unread=true' : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
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

/** Where a notification leads: its monitor's page, scrolled to the change. */
export const notificationHref = (n: NotificationDto) => `/monitors/${n.monitorId}#change-${n.eventId}`;

/** Opens a notification: marks it read and goes to the change. */
export function useOpenNotification() {
  const navigate = useNavigate();
  const markRead = useMarkRead();
  return (n: NotificationDto) => {
    if (!n.isRead) markRead.mutate(n.id);
    navigate(notificationHref(n));
  };
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
