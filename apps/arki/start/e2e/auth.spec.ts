import { expect, test } from '@playwright/test';

/**
 * Signed-in pages must send a signed-out visitor to sign in, on the server's first answer too. The session check runs
 * during server rendering, where the browser auth client cannot reach the auth API; a guard that calls it there turns
 * the redirect into a 500 page.
 */
test.describe('signed-out visitor', () => {
  test('opening /profile redirects to the sign-in page, not an error', async ({ page }) => {
    const response = await page.request.get('/profile', { maxRedirects: 0 });
    expect(response.status()).toBeGreaterThanOrEqual(300);
    expect(response.status()).toBeLessThan(400);
    expect(response.headers()['location']).toMatch(/\/auth\/sign-in$/);

    await page.goto('/profile');
    await expect(page).toHaveURL(/\/auth\/sign-in$/);
  });
});
