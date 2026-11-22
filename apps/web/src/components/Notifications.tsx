import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { NotificationDto } from '@monitorly/contracts';
import { useLiveUpdates, useMarkAllRead, useMarkRead, useNotifications } from '../hooks/useNotifications';
import { relativeTime } from '../lib/format';

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
      <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0a3 3 0 1 1-6 0m6 0H9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Opens the change: marks it read and goes to its monitor. */
function useOpenNotification() {
  const navigate = useNavigate();
  const markRead = useMarkRead();
  return (n: NotificationDto) => {
    if (!n.isRead) markRead.mutate(n.id);
    navigate(`/monitors/${n.monitorId}`);
  };
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const { data } = useNotifications();
  const markAll = useMarkAllRead();
  const openNotification = useOpenNotification();
  const unread = data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={panel}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-expanded={open}
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread > 0 && (
              <button type="button" className="text-xs font-medium text-indigo-600 hover:underline" onClick={() => markAll.mutate()}>
                Mark all as read
              </button>
            )}
          </div>
          {!data || data.notifications.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">No alerts yet. Matches for your monitors will show up here.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {data.notifications.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      openNotification(n);
                    }}
                    className={`flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50 ${n.isRead ? '' : 'bg-indigo-50/40'}`}
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.isRead ? 'bg-transparent' : 'bg-indigo-600'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">{n.title}</span>
                      <span className="line-clamp-2 block text-sm text-slate-600">{n.message}</span>
                      <span className="mt-0.5 block text-xs text-slate-400">
                        {n.monitorName ?? 'Monitor'} · {relativeTime(n.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const TOAST_MS = 8_000;

/** Live pop-ups for alerts that arrive while the app is open. */
export function LiveAlerts({ userId }: { userId: string | undefined }) {
  const [toasts, setToasts] = useState<NotificationDto[]>([]);
  const openNotification = useOpenNotification();
  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  useLiveUpdates(userId, (n) => {
    setToasts((t) => [n, ...t.filter((x) => x.id !== n.id)].slice(0, 3));
    setTimeout(() => dismiss(n.id), TOAST_MS);
  });

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-30 flex w-80 flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((n) => (
        <div key={n.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
          <div className="flex items-start gap-2">
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                dismiss(n.id);
                openNotification(n);
              }}
            >
              <span className="block text-xs font-medium text-indigo-600">{n.monitorName ?? 'New alert'}</span>
              <span className="block truncate text-sm font-semibold text-slate-900">{n.title}</span>
              <span className="line-clamp-2 block text-sm text-slate-600">{n.message}</span>
            </button>
            <button type="button" className="text-slate-400 hover:text-slate-600" aria-label="Dismiss" onClick={() => dismiss(n.id)}>
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
