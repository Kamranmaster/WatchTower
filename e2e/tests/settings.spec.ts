import { createMonitor, expect, test, toast } from '../support/fixtures';

test('saves account settings, and new monitors use them', async ({ page, user }) => {
  await page.goto('/settings');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(user.email);
  await expect(page.getByLabel('Email', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();

  await page.getByLabel('Name').fill('Riya S.');
  await page.getByLabel('Email alerts').uncheck();
  await page.getByLabel('Default check frequency').selectOption({ label: 'Every hour' });
  await expect(page.getByText('You have unsaved changes.')).toBeVisible();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(toast(page, 'Settings saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled();

  await page.reload();
  await expect(page.getByLabel('Name')).toHaveValue('Riya S.');
  await expect(page.getByLabel('Email alerts')).not.toBeChecked();
  await expect(page.getByRole('button', { name: /Account menu for Riya S\./ })).toBeVisible();

  await page.goto('/monitors/new');
  await expect(page.getByLabel('Check')).toHaveValue('60');
  await expect(page.getByText('Email alerts are turned off for your whole account')).toBeVisible();
});

test('validates the name and guards unsaved changes', async ({ page, user: _ }) => {
  await page.goto('/settings');
  await page.getByLabel('Name').fill('   ');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Name is required')).toBeVisible();
  await expect(page.getByLabel('Name')).toBeFocused();

  await page.getByRole('link', { name: 'Dashboard' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Discard your changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('per-monitor alerts change right away', async ({ page, user: _ }) => {
  const monitor = await createMonitor(page.request, { name: 'Toggle me', notifyEmail: false });
  await page.goto('/settings');
  const row = page.getByRole('group', { name: 'Alerts for Toggle me' });
  await row.getByLabel('Email').check();
  await expect(toast(page, 'Email alerts on for “Toggle me”.')).toBeVisible();
  await row.getByLabel('In-app').uncheck();
  await expect(toast(page, 'In-app alerts off for “Toggle me”.')).toBeVisible();

  const saved = await (await page.request.get(`/api/monitors/${monitor.id}`)).json();
  expect(saved.monitor).toMatchObject({ notifyEmail: true, notifyInApp: false });
});
