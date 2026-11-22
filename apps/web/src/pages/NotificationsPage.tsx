import { useState } from 'react';
import { useMarkAllRead, useNotificationHistory, useNotifications, useOpenNotification } from '../hooks/useNotifications';
import { usePageTitle } from '../hooks/usePageTitle';
import { NotificationItem } from '../components/Notifications';
import { useToast } from '../components/Toasts';
import { Button, ButtonLink, Card, EmptyState, ErrorState, FilterTabs, ListSkeleton, LoadMore } from '../components/ui';

type Filter = 'all' | 'unread';

export function NotificationsPage() {
  usePageTitle('Notifications');
  const [filter, setFilter] = useState<Filter>('all');
  const history = useNotificationHistory(filter === 'unread');
  const latest = useNotifications(); // shares the unread count with the bell
  const markAll = useMarkAllRead();
  const openNotification = useOpenNotification();
  const toast = useToast();
  const unread = latest.data?.unreadCount ?? 0;
  const list = history.data?.pages.flatMap((p) => p.notifications) ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="text-slate-600">Every alert your monitors have sent you, newest first.</p>
        </div>
        {unread > 0 && (
          <Button
            variant="secondary"
            loading={markAll.isPending}
            onClick={() =>
              markAll.mutate(undefined, {
                onSuccess: ({ updated }) => toast.success(`Marked ${updated} notification${updated === 1 ? '' : 's'} as read.`),
                onError: (err) => toast.error(err, 'Couldn’t mark them as read'),
              })
            }
          >
            Mark all as read
          </Button>
        )}
      </header>

      <Card padding="none" aria-label="Notification list">
        <div className="border-b border-slate-100 p-4 sm:px-5">
          <FilterTabs
            label="Show notifications"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread', count: unread },
            ]}
          />
        </div>
        {history.isPending ? (
          <div className="px-4 pb-2 sm:px-5">
            <ListSkeleton label="notifications" />
          </div>
        ) : history.isError && list.length === 0 ? (
          <div className="p-4">
            <ErrorState title="Couldn’t load notifications" error={history.error} onRetry={() => history.refetch()} retrying={history.isFetching} />
          </div>
        ) : list.length === 0 ? (
          filter === 'unread' ? (
            <EmptyState title="You’re all caught up">No unread notifications.</EmptyState>
          ) : (
            <EmptyState title="No alerts yet" action={<ButtonLink to="/" variant="secondary">Go to dashboard</ButtonLink>}>
              When a change on one of your pages matches your filters, you’ll get an alert here (and live, while Monitorly is open).
            </EmptyState>
          )
        ) : (
          <div className="pb-4">
            <ul className="divide-y divide-slate-100">
              {list.map((n) => (
                <li key={n.id}>
                  <NotificationItem n={n} onOpen={openNotification} />
                </li>
              ))}
            </ul>
            <LoadMore
              hasMore={history.hasNextPage}
              loading={history.isFetchingNextPage}
              error={history.isFetchNextPageError ? history.error : null}
              onLoad={() => void history.fetchNextPage()}
              label="Load older notifications"
            />
          </div>
        )}
      </Card>
    </div>
  );
}
