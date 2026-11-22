import { createMonitor, expect, expectNoHorizontalScroll, seed, test } from '../support/fixtures';

// Runs in the "mobile" project (Pixel 7 viewport, touch).

test('key pages fit a phone screen without sideways scrolling', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request, {
    name: 'A monitor with a really quite long name to see how it wraps',
    url: 'https://example.com/careers/engineering/internships/2027/summer?location=remote&team=platform',
  });
  await seed.events(monitor.id, [
    { title: 'Frontend Developer Intern — Platform Experience Team (Remote, India)', verdict: 'matched', description: 'Remote' },
    { title: 'Senior Engineer', verdict: 'filtered_out' },
  ]);
  await seed.runs(monitor.id, 3);
  await seed.notify(monitor.id, { count: 2 });

  for (const path of ['/', `/monitors/${monitor.id}`, `/monitors/${monitor.id}/edit`, '/monitors/new', '/notifications', '/settings']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalScroll(page, path);
  }
});

test('the menu holds the page links on small screens', async ({ page, user: _ }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'New monitor', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New monitor' })).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test('the bell panel fits on screen', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request);
  await seed.notify(monitor.id, { count: 2 });
  await page.goto('/');
  await page.getByRole('button', { name: /Notifications \(2 unread\)/ }).click();
  const panel = page.getByRole('link', { name: 'View all notifications' }).locator('xpath=ancestor::div[@id][1]');
  const box = await panel.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
});
