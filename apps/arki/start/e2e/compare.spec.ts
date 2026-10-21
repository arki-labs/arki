import { expect, test } from '@playwright/test';

test.describe('compare page', () => {
  test('renders the three Arki cell states and both closing sections', async ({ page }) => {
    await page.goto('/compare');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Laravel, Rails and AdonisJS');
    await expect(page.getByTestId('compare-row').first()).toBeVisible();

    // A shipped cell links to its package page.
    const shipped = page.locator('[data-cell="shipped"]').first();
    await expect(shipped).toBeVisible();
    await expect(shipped.getByRole('link')).toHaveAttribute('href', /^\/packages\/[a-z-]+$/);

    // A planned cell names a release wave or batch.
    await expect(page.locator('[data-cell="planned"]').first()).toContainText('Release wave:');

    // A not-planned cell gives its reason.
    const notPlanned = page.locator('[data-cell="not-planned"]').first();
    await expect(notPlanned).toBeVisible();
    await expect(notPlanned).toContainText(/\w+(\s+\w+){4,}/);

    await expect(page.getByRole('heading', { name: 'Choose something else when…' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What adopting Dot costs' })).toBeVisible();
  });
});

test.describe('dot new preview', () => {
  test('lists planned files per template and says nothing runs in the browser', async ({ page }) => {
    await page.goto('/docs/dot-new');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('What dot new writes');
    await expect(page.getByText('Nothing runs in your browser')).toBeVisible();
    await expect(page.getByTestId('dot-new-template').first()).toBeVisible();
    await expect(page.getByTestId('dot-new-file').first()).toContainText('bytes');
    await expect(page.getByRole('heading', { name: 'Next steps' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What you own afterwards' }).first()).toBeVisible();
  });
});

test.describe('upgrade story', () => {
  test('shows the no-story state and the upgrade procedure, without a timeline', async ({ page }) => {
    await page.goto('/docs/upgrade-story');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Upgrade story');
    await expect(page.getByTestId('upgrade-no-story')).toContainText('No recorded upgrade yet');
    await expect(page.getByRole('heading', { name: 'The upgrade procedure' })).toBeVisible();
  });
});

test.describe('security.txt', () => {
  test('is plain text with Contact, Expires and Policy', async ({ request }) => {
    const response = await request.get('/.well-known/security.txt');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/plain');
    const body = await response.text();
    expect(body).toMatch(/^Contact: https:\/\/github\.com\/\S+$/m);
    expect(body).toMatch(/^Expires: \d{4}-\d{2}-\d{2}T/m);
    expect(body).toMatch(/^Policy: https:\/\/\S+$/m);
    const expires = Date.parse(/^Expires: (.+)$/m.exec(body)?.[1] ?? '');
    expect(expires).toBeGreaterThan(Date.now());
  });
});
