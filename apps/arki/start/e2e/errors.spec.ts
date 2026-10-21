import { expect, test } from '@playwright/test';

// Codes taken from src/generated/errors.json: one with an upper-case id, one with a dot.
const THROWN_CODE = 'ARKI_ASYNC_E001';
const DOTTED_CODE = 'async.cancelled';

test.describe('/errors', () => {
  for (const code of [THROWN_CODE, DOTTED_CODE]) {
    test(`/errors/${code} renders what happened, package and source`, async ({ page }) => {
      const response = await page.goto(`/errors/${code}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(code);
      await expect(page.getByRole('heading', { name: 'What happened' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Where it comes from' })).toBeVisible();
      await expect(page.getByRole('link', { name: /^src\/.+:\d+$/ })).toHaveAttribute('href', /\/blob\/HEAD\/.+#L\d+$/);
    });
  }

  test('an unknown code is a 404 that offers the search', async ({ page }) => {
    const response = await page.goto('/errors/not.a.real.code');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('search')).toBeVisible();
    await expect(page.getByRole('link', { name: 'See all error codes' })).toBeVisible();
  });

  test('search filters the list through a plain ?q= request', async ({ page }) => {
    await page.goto('/errors');
    const all = await page.getByTestId('error-row').count();
    await page.goto(`/errors?q=${DOTTED_CODE}`);
    const rows = page.getByTestId('error-row');
    expect(await rows.count()).toBeLessThan(all);
    await expect(rows.first()).toContainText(DOTTED_CODE);
  });

  test('/errors/index.json lists every code', async ({ request }) => {
    const response = await request.get('/errors/index.json');
    expect(response.status()).toBe(200);
    const body: unknown = await response.json();
    expect(Array.isArray(body) && body.length > 0).toBe(true);
  });
});
