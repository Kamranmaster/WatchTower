import { createMonitor, expect, seed, test, toast } from '../support/fixtures';

test('a live alert pops up, counts in the bell, and opens the exact change', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request, { name: 'Live jobs' });
  // Wait until the live-updates socket is connected (socket.io's "40" connect packet) before the alert is sent.
  const connected = page
    .waitForEvent('websocket', (ws) => ws.url().includes('/socket.io/'))
    .then((ws) => ws.waitForEvent('framereceived', (frame) => String(frame.payload).startsWith('40')));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  await connected;

  const { notifications } = await seed.notify(monitor.id, { title: 'Frontend Intern', live: true });
  const popup = toast(page, 'New: Frontend Intern');
  await expect(popup).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
  await expect(page.getByText('Unread alerts').locator('..')).toContainText('1');

  await popup.click();
  await expect(page).toHaveURL(new RegExp(`/monitors/${monitor.id}#change-${notifications[0]!.eventId}$`));
  const change = page.locator(`#change-${notifications[0]!.eventId}`);
  await expect(change).toBeFocused();
  await expect(change).toContainText('Frontend Intern');
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible(); // read now
});

test('the bell lists alerts, marks them read and links to the full history', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request, { name: 'Bell jobs' });
  await seed.notify(monitor.id, { count: 3 });
  await page.goto('/');

  const bell = page.getByRole('button', { name: 'Notifications (3 unread)' });
  await bell.click();
  await expect(bell).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /Unread: New: Role 3/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bell).toHaveAttribute('aria-expanded', 'false');
  await expect(bell).toBeFocused();

  await bell.click();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View all notifications' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
});

test('notifications page: unread filter, mark all as read, older pages', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request, { name: 'Many jobs' });
  await seed.notify(monitor.id, { count: 22, read: true });
  await seed.notify(monitor.id, { title: 'Brand New Role' });
  await page.goto('/notifications');

  const list = page.getByRole('region', { name: 'Notification list' });
  await expect(list.getByRole('listitem')).toHaveCount(20);
  await expect(list.getByRole('listitem').first()).toContainText('New: Brand New Role');
  await list.getByRole('button', { name: 'Load older notifications' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(23);

  await list.getByRole('button', { name: 'Unread (1)' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(toast(page, 'Marked 1 notification as read.')).toBeVisible();
  await expect(list.getByText('You’re all caught up')).toBeVisible();
});

test('with no alerts, the page says what will show up', async ({ page, user: _ }) => {
  await page.goto('/notifications');
  await expect(page.getByText('No alerts yet')).toBeVisible();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByText('No alerts yet. Matches for your monitors will show up here.')).toBeVisible();
});
