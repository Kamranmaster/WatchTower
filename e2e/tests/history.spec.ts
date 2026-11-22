import { createMonitor, expect, seed, test } from '../support/fixtures';

test('change history explains every verdict, filters to alerts and loads older pages', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request, { name: 'History test' });
  // 30 changes: newest first are 3 with distinct verdicts, then 27 alerts.
  await seed.events(monitor.id, [
    { title: 'Senior Engineer', verdict: 'filtered_out', reasons: ['mentions “senior”'], minutesAgo: 1 },
    { title: 'Warehouse Intern', verdict: 'not_relevant', minutesAgo: 2 },
    { title: 'Design Intern', verdict: 'matched', minutesAgo: 3 },
    ...Array.from({ length: 27 }, (_, i) => ({ title: `Old Role ${i + 1}`, verdict: 'matched', minutesAgo: 10 + i })),
  ]);

  await page.goto(`/monitors/${monitor.id}`);
  const changes = page.getByRole('region', { name: 'Changes' });
  await expect(changes.getByText('No alert · filtered out: mentions “senior”')).toBeVisible();
  await expect(changes.getByText('No alert · AI judged it not relevant: Not the kind of role you asked for')).toBeVisible();
  await expect(changes.getByText('AI summary: Design Intern is open.')).toBeVisible();
  await expect(changes.getByRole('listitem')).toHaveCount(25);

  await changes.getByRole('button', { name: 'Load older changes' }).click();
  await expect(changes.getByRole('listitem')).toHaveCount(30);
  await expect(changes.getByRole('button', { name: 'Load older changes' })).toBeHidden();

  await changes.getByRole('button', { name: 'Alerts only' }).click();
  await expect(changes.getByRole('button', { name: 'Alerts only' })).toHaveAttribute('aria-pressed', 'true');
  await expect(changes.getByText('Senior Engineer')).toBeHidden();
  await expect(changes.getByRole('listitem')).toHaveCount(25);
  await changes.getByRole('button', { name: 'Load older changes' }).click();
  await expect(changes.getByRole('listitem')).toHaveCount(28);
});

test('empty states explain what will appear, per filter', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request);
  await page.goto(`/monitors/${monitor.id}`);
  const changes = page.getByRole('region', { name: 'Changes' });
  await expect(changes.getByText('The first check saves the page as a baseline.')).toBeVisible();
  await seed.events(monitor.id, [{ title: 'Senior Engineer', verdict: 'filtered_out' }]);
  await page.reload();
  await changes.getByRole('button', { name: 'Alerts only' }).click();
  await expect(changes.getByText('No alerts yet')).toBeVisible();
  await expect(changes.getByText(/Switch to “All changes” to see what was filtered out/)).toBeVisible();
});

test('check history shows more on request', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request);
  await seed.runs(monitor.id, 14);
  await page.goto(`/monitors/${monitor.id}`);
  const history = page.getByRole('region', { name: 'Check history' });
  await expect(history.getByRole('listitem')).toHaveCount(10);
  await expect(history.getByText('No changes').first()).toBeVisible();
  await history.getByRole('button', { name: 'Show more checks' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(14);
  await expect(history.getByRole('button', { name: 'Show more checks' })).toBeHidden();
});
