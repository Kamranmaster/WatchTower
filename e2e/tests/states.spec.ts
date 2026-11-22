import { createMonitor, expect, test, toast } from '../support/fixtures';

test('a failed load shows an error with a retry that works', async ({ page, user: _ }) => {
  // Fails until the test "fixes the server" (the app retries server errors twice on its own first).
  let failing = true;
  await page.route('**/api/monitors', (route) =>
    failing && route.request().method() === 'GET'
      ? route.fulfill({ status: 500, json: { error: 'Internal server error' } })
      : route.continue(),
  );
  await page.goto('/');
  const error = page.getByRole('alert').filter({ hasText: 'Couldn’t load your monitors' });
  await expect(error).toContainText('Something went wrong on our side. Try again in a moment.');
  failing = false;
  await error.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your first monitor' })).toBeVisible();
});

test('the API being unreachable is explained', async ({ page, user: _ }) => {
  await page.route('**/api/monitors', (route) => route.abort('connectionrefused'));
  await page.goto('/');
  await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t load your monitors' })).toContainText(
    'Can’t reach Monitorly. Check your connection and try again.',
  );
});

test('a failed action is reported in a toast and changes nothing', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request, { name: 'Sticky' });
  await page.route(`**/api/monitors/${monitor.id}/pause`, (route) => route.fulfill({ status: 500, json: { error: 'Internal server error' } }));
  await page.goto(`/monitors/${monitor.id}`);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(toast(page, /Couldn’t pause the monitor: Something went wrong on our side/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled();
});

test('loading states show placeholders, announced to screen readers', async ({ page, user: _ }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/monitors', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Loading your monitors…' })).toBeAttached();
  release();
  await expect(page.getByRole('heading', { name: 'Set up your first monitor' })).toBeVisible();
});

test('unknown monitors and pages get a clear "not found"', async ({ page, user: _ }) => {
  await page.goto('/monitors/64b7f0c2a1b2c3d4e5f60718');
  await expect(page.getByRole('heading', { level: 1, name: 'Monitor not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to dashboard' })).toBeVisible();
  await page.goto('/monitors/64b7f0c2a1b2c3d4e5f60718/edit');
  await expect(page.getByText('Monitor not found')).toBeVisible();
  await page.goto('/no/such/page');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(page).toHaveTitle('Page not found · Monitorly');
});

test('going offline shows a banner until the connection is back', async ({ page, context, user: _ }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('You’re offline.')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('You’re offline.')).toBeHidden();
});
