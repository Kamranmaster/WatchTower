import { createMonitor, expect, seed, test, toast } from '../support/fixtures';

test('creates a monitor with hand-written filters when AI is unavailable', async ({ page, user: _ }) => {
  await page.goto('/monitors/new');
  await page.getByLabel('Website URL').fill('https://example.com/careers');
  await page.getByLabel('Name (optional)').fill('Example careers');
  await page.getByLabel('Describe it in your own words').fill('New frontend intern roles, remote. No senior roles.');
  await page.getByRole('button', { name: 'Next: review filters' }).click();

  // The e2e API runs without an AI key: the form says so and lets you fill the filters in.
  await expect(page.getByRole('alert').filter({ hasText: 'AI setup is not available' })).toBeVisible();
  await page.getByLabel('Must mention').fill('frontend, intern');
  await page.getByLabel('Locations').fill('Remote');
  await page.getByLabel('Ignore if it mentions').fill('senior');
  await expect(page.getByText('You’ll be alerted about new job listings that mention “frontend” and “intern”, in Remote, unless they mention “senior”.')).toBeVisible();
  await page.getByRole('button', { name: 'Create monitor' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Example careers' })).toBeVisible();
  await expect(toast(page, 'Created “Example careers”')).toBeVisible();
  await expect(page.getByText('frontend', { exact: true })).toBeVisible();
  await expect(page.getByText('No changes yet')).toBeVisible();
});

test('AI-suggested filters are shown for review before anything is saved', async ({ page, user: _ }) => {
  let created = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/monitors')) created++;
  });
  await page.route('**/api/monitors/interpret', (route) =>
    route.fulfill({
      json: {
        model: 'fake-model',
        interpretation: {
          monitorType: 'job_listing',
          rules: { keywords: ['data analyst', 'intern'], locations: ['Mumbai'], excludeKeywords: ['senior'] },
          notes: ['“Paid only” can’t be checked by the filters'],
        },
      },
    }),
  );

  await page.goto('/monitors/new');
  await page.getByLabel('Website URL').fill('https://example.com/jobs');
  await page.getByLabel('Describe it in your own words').fill('Paid data analyst internships in Mumbai, not senior');
  await page.getByRole('button', { name: 'Next: review filters' }).click();

  await expect(page.getByText('Suggested from your description.')).toBeVisible();
  await expect(page.getByLabel('Must mention')).toHaveValue('data analyst, intern');
  await expect(page.getByLabel('Locations')).toHaveValue('Mumbai');
  await expect(page.getByText('“Paid only” can’t be checked by the filters')).toBeVisible();
  expect(created).toBe(0);

  await page.getByRole('button', { name: 'Create monitor' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'example.com' })).toBeVisible();
  expect(created).toBe(1);
});

test('validates the form in the browser and shows the server’s URL check on the field', async ({ page, user: _ }) => {
  await page.goto('/monitors/new');
  await page.getByRole('button', { name: 'Next: review filters' }).click();
  await expect(page.getByText('Website URL is required')).toBeVisible();
  await expect(page.getByText('Describe what to monitor (at least 5 characters)')).toBeVisible();
  await expect(page.getByLabel('Website URL')).toBeFocused();
  await expect(page.getByText('2 fields need your attention before this can be saved.')).toBeVisible();

  await page.getByLabel('Website URL').fill('example.com/careers');
  await page.getByLabel('Website URL').blur();
  await expect(page.getByText('Enter a full URL, including https://')).toBeVisible();

  // Passes the browser's check; the API refuses private addresses.
  await page.getByLabel('Website URL').fill('http://localhost:3000/admin');
  await page.getByLabel('Describe it in your own words').fill('Anything new on this page');
  await page.getByRole('button', { name: 'Next: review filters' }).click(); // AI unavailable
  await page.getByRole('button', { name: 'Create monitor' }).click();
  const urlError = page.locator('#' + (await page.getByLabel('Website URL').getAttribute('aria-describedby')));
  await expect(urlError).toHaveText(/private or internal network/);
  await expect(page.getByLabel('Website URL')).toBeFocused();

  // Editing the field clears the server's message.
  await page.getByLabel('Website URL').fill('https://example.com/careers');
  await expect(urlError).not.toHaveText(/private or internal network/);
});

test('edits with an unsaved-changes guard, pauses, resumes and deletes', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request, { name: 'Lifecycle test' });
  await page.goto(`/monitors/${monitor.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Lifecycle test' })).toBeVisible();

  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Check').selectOption({ label: 'Every hour' });
  await page.getByRole('button', { name: 'Cancel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard your changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/edit$/);

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(page, 'Changes saved.')).toBeVisible();
  await expect(page.getByText('Every hour')).toBeVisible();

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('This monitor is paused.')).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  await page.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete “Lifecycle test”?' });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeFocused();

  await page.getByRole('button', { name: 'Delete' }).click();
  await confirm.getByRole('button', { name: 'Delete monitor' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(toast(page, 'Deleted “Lifecycle test”.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your first monitor' })).toBeVisible();
});

test('dashboard: failing monitors up front, then search, filter and sort', async ({ page, user: _ }) => {
  const jobs = await createMonitor(page.request, { name: 'Alpha jobs' });
  const shop = await createMonitor(page.request, { name: 'Beta shop', url: 'https://example.org/shop', instruction: 'Restocked sneakers' });
  const news = await createMonitor(page.request, { name: 'Gamma news' });
  await page.request.post(`/api/monitors/${shop.id}/pause`);
  await seed.fail(news.id, 'The page took too long to respond');
  void jobs;

  await page.goto('/');
  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(attention.getByRole('link', { name: 'Gamma news' })).toBeVisible();
  await expect(attention.getByText('The page took too long to respond')).toBeVisible();

  const list = page.getByRole('region', { name: /Your monitors/ });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await list.getByRole('button', { name: 'Paused (1)' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByRole('link', { name: 'Beta shop' })).toBeVisible();

  await list.getByRole('button', { name: 'All (3)' }).click();
  await list.getByLabel('Search monitors').fill('sneakers');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByLabel('Search monitors').fill('nothing like this');
  await expect(list.getByText('No monitors match')).toBeVisible();
  await list.getByRole('button', { name: 'Clear filters' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(3);

  await list.getByLabel('Sort').selectOption('name');
  await expect(list.getByRole('listitem').first()).toContainText('Alpha jobs');

  // Retrying a failing monitor clears its error.
  await attention.getByRole('button', { name: 'Retry Gamma news' }).click();
  await expect(toast(page, 'Retrying “Gamma news”')).toBeVisible();
  await expect(attention).toBeHidden();
});
