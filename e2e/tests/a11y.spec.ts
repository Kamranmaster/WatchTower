import { createMonitor, expect, expectAccessible, seed, test } from '../support/fixtures';

test('logged-out pages pass an accessibility scan', async ({ page }) => {
  await page.goto('/login');
  await expectAccessible(page, 'login');
  await page.goto('/register');
  await page.getByRole('button', { name: 'Create account' }).click(); // with errors shown
  await expect(page.getByText('Name is required')).toBeVisible();
  await expectAccessible(page, 'register with errors');
});

test('main pages pass an accessibility scan, with real content', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request, { name: 'Scan me' });
  await seed.events(monitor.id, [
    { title: 'Frontend Intern', verdict: 'matched', description: 'Remote' },
    { title: 'Senior Engineer', verdict: 'filtered_out' },
    { title: 'Warehouse Intern', verdict: 'not_relevant' },
  ]);
  await seed.runs(monitor.id, 3);
  await seed.notify(monitor.id, { count: 2 });

  for (const [path, label] of [
    ['/', 'dashboard'],
    [`/monitors/${monitor.id}`, 'monitor detail'],
    [`/monitors/${monitor.id}/edit`, 'edit form'],
    ['/notifications', 'notifications'],
    ['/settings', 'settings'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectAccessible(page, label);
  }

  await page.goto('/monitors/new');
  await page.getByRole('button', { name: 'Next: review filters' }).click();
  await expectAccessible(page, 'new monitor with errors');

  await page.goto('/');
  await page.getByRole('button', { name: /Notifications \(\d+ unread\)/ }).click();
  await expectAccessible(page, 'bell panel open');
});

test('keyboard: skip link, focus after navigation, menus close with Escape', async ({ page, user: _ }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);

  // In-app navigation moves focus to the new page's heading.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Notifications' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeFocused();
  await expect(page).toHaveTitle('Notifications · Monitorly');

  const menu = page.getByRole('button', { name: /Account menu/ });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'Settings' })).toBeHidden();
  await expect(menu).toBeFocused();
});
