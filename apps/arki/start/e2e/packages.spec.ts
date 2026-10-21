import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { packagesFileSchema } from '@arki/arki-release/site-schema';

// The generated list is the source of truth: the page must show every admitted package, no more, no less.
const packages = packagesFileSchema.parse(
  JSON.parse(readFileSync(new URL('../src/generated/packages.json', import.meta.url), 'utf8')),
);
const dot = packages.find(entry => entry.short === 'dot');

test.describe('/packages', () => {
  test('the index has one row per tier 1, tier 2 or untiered package', async ({ page }) => {
    // Same rule as the plan's `jq '[.[]|select(.tier<=2)]|length'`: jq orders null below numbers, so untiered counts.
    const expected = packages.filter(entry => entry.tier === null || entry.tier <= 2).length;
    const response = await page.goto('/packages');
    expect(response?.status()).toBe(200);
    const table = page.getByRole('table', { name: 'Packages' });
    await expect(table.locator('tr[data-package]')).toHaveCount(expected);
    await expect(table.getByRole('rowheader', { name: 'Tier 1: the stack' })).toBeVisible();
    await expect(table.getByRole('rowheader', { name: 'Tier 2: standalone libraries' })).toBeVisible();
  });

  test('/packages/dot/next shows the candidate banner with the next version', async ({ page }) => {
    expect(dot?.nextVersion).toBeTruthy();
    const response = await page.goto('/packages/dot/next');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: '@arki/dot' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: `candidate for v${dot?.nextVersion}` })).toBeVisible();
    await expect(page.getByText(`@arki/dot@${dot?.nextVersion}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Versions' }).locator('a[aria-current="page"]')).toHaveText(
      `${dot?.nextVersion}`,
    );
    await expect(page.getByRole('region', { name: 'Public imports' })).toBeVisible();
  });

  test('an archived version says it is not supported', async ({ page }) => {
    const archived = dot?.versions.find(version => version.archive);
    test.skip(archived === undefined, 'dot has no archived snapshot');
    await page.goto(`/packages/dot/${archived?.version}`);
    await expect(page.getByRole('note').filter({ hasText: 'Archive, not supported.' })).toBeVisible();
  });

  test('a doc page renders by its path', async ({ page }) => {
    const response = await page.goto('/packages/dot/next/README');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('link', { name: `All docs for @arki/dot@${dot?.nextVersion}` })).toBeVisible();
  });

  test('/packages/dot/api.json returns the API index as JSON', async ({ request }) => {
    const response = await request.get('/packages/dot/api.json');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
    const body: unknown = await response.json();
    expect(body).toMatchObject({ package: '@arki/dot', version: dot?.nextVersion });
  });

  test('/packages/index.json returns the package list', async ({ request }) => {
    const response = await request.get('/packages/index.json');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(packagesFileSchema.parse(await response.json())).toHaveLength(packages.length);
  });

  test('an unknown package or version is a 404', async ({ page, request }) => {
    const unknownPackage = await page.goto('/packages/no-such-package');
    expect(unknownPackage?.status()).toBe(404);
    const unknownVersion = await page.goto('/packages/dot/99.99.99');
    expect(unknownVersion?.status()).toBe(404);
    const unknownApi = await request.get('/packages/no-such-package/api.json');
    expect(unknownApi.status()).toBe(404);
  });
});
