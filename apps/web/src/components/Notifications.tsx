import { useId } from 'react';
import { Link } from 'react-router';
import type { NotificationDto } from '@monitorly/contracts';
import { useLiveUpdates, useMarkAllRead, useNotifications, useOpenNotification } from '../hooks/useNotifications';
import { usePopover } from '../hooks/usePopover';
import { relativeTime } from '../lib/format';
import { useToast } from './Toasts';
import { ErrorState, ListSkeleton, Time, cx } from './ui';

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
      <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0a3 3 0 1 1-6 0m6 0H9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One notification row; used in the bell panel and on the notifications page. */
export function NotificationItem({ n, onOpen }: { n: NotificationDto; onOpen: (n: NotificationDto) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      className={cx(
        'flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600',
        !n.isRead && 'bg-indigo-50/50',
      )}
    >
      <span aria-hidden="true" className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.isRead ? 'bg-transparent' : 'bg-indigo-600')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-900">
          {!n.isRead && <span className="sr-only">Unread: </span>}
          {n.title}
        </span>
        <span className="line-clamp-2 block text-sm text-slate-600">{n.message}</span>
        <span className="mt-0.5 block text-xs text-slate-500">
          {n.monitorName ?? 'Monitor'} · <Time iso={n.createdAt}>{relativeTime(n.createdAt)}</Time>
        </span>
      </span>
    </button>
  );
}

export function NotificationBell() {
  const popover = usePopover();
  const panelId = useId();
  const latest = useNotifications();
  const markAll = useMarkAllRead();
  const toast = useToast();
  const openNotification = useOpenNotification();
  const unread = latest.data?.unreadCount ?? 0;
  const list = latest.data?.notifications ?? [];

  return (
    <div className="relative" ref={popover.container}>
      <button
        ref={popover.trigger}
        type="button"
        onClick={popover.toggle}
        className="relative grid h-10 w-10 place-items-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600"
        aria-expanded={popover.open}
        aria-controls={panelId}
      >
        <BellIcon />
        <span className="sr-only">{unread ? `Notifications (${unread} unread)` : 'Notifications'}</span>
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {popover.open && (
        <div
          id={panelId}
          className="fixed inset-x-2 top-16 z-30 rounded-lg border border-slate-200 bg-white shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-96"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread > 0 && (
              <button
                type="button"
                className="rounded text-xs font-medium text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:opacity-50"
                disabled={markAll.isPending}
                onClick={() => markAll.mutate(undefined, { onError: (err) => toast.error(err, 'Couldn’t mark them as read') })}
              >
                Mark all as read
              </button>
            )}
          </div>
          {latest.isPending ? (
            <div className="px-4">
              <ListSkeleton rows={2} label="notifications" />
            </div>
          ) : latest.isError ? (
            <div className="p-3">
              <ErrorState compact title="Couldn’t load notifications" error={latest.error} onRetry={() => latest.refetch()} retrying={latest.isFetching} />
            </div>
          ) : list.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">No alerts yet. Matches for your monitors will show up here.</p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto sm:max-h-96">
              {list.map((n) => (
                <li key={n.id}>
                  <NotificationItem
                    n={n}
                    onOpen={(item) => {
                      popover.close(); // also when it's for the page already open
                      openNotification(item);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-slate-100 px-4 py-2.5 text-center">
            <Link to="/notifications" className="text-sm font-medium text-indigo-700 hover:underline">
              View all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

/** Live pop-ups for alerts that arrive while the app is open. */
export function LiveAlerts({ userId }: { userId: string | undefined }) {
  const toast = useToast();
  const openNotification = useOpenNotification();
  useLiveUpdates(userId, (n) => toast.notification(n, () => openNotification(n)));
  return null;
}
