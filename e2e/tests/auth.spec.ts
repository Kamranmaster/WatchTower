import { randomUUID } from 'node:crypto';
import { expect, registerUser, test } from '../support/fixtures';

test('signs up, sees the onboarding, logs out and back in', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.com`;
  await page.goto('/register');
  await expect(page).toHaveTitle('Create your account · Monitorly');
  await page.getByLabel('Name').fill('Asha Verma');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Hi Asha' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your first monitor' })).toBeVisible();

  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hi Asha' })).toBeVisible();
});

test('checks sign-up fields in the browser before sending anything', async ({ page }) => {
  let sent = 0;
  page.on('request', (req) => {
    if (req.url().endsWith('/api/auth/register')) sent++;
  });
  await page.goto('/register');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByText('Name is required')).toBeVisible();
  await expect(page.getByText('Enter a valid email address')).toBeVisible();
  await expect(page.getByText('Use at least 8 characters')).toBeVisible();
  await expect(page.getByLabel('Name')).toBeFocused();
  await expect(page.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Name').fill('Asha');
  await page.getByLabel('Email').fill('asha@example');
  await page.getByLabel(/^Password/).fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByLabel('Email')).toBeFocused();
  expect(sent).toBe(0);
});

test('reports a taken email next to the field', async ({ page, browser }) => {
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const existing = await registerUser(other.request);
  await other.close();

  await page.goto('/register');
  await page.getByLabel('Name').fill('Someone Else');
  await page.getByLabel('Email').fill(existing.email);
  await page.getByLabel(/^Password/).fill('another-good-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('An account with this email already exists')).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
});

test('a wrong password is explained; protected pages come back after login', async ({ page, browser }) => {
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const user = await registerUser(other.request);
  await other.close();

  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel(/^Password/).fill('not-the-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect email or password');

  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel(/^Password/)).toHaveAttribute('type', 'text');
  await page.getByLabel(/^Password/).fill(user.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});
