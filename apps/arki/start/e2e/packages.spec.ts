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
    await expect(table.getByRole('rowheader', { name: /^Tier 1: the stack/ })).toBeVisible();
    await expect(table.getByRole('rowheader', { name: /^Tier 2: standalone libraries/ })).toBeVisible();
  });

  test('the filter is a plain GET form: the status chip and the query narrow the list', async ({ page }) => {
    const archived = packages.filter(entry => entry.status === 'archive');
    await page.goto('/packages?status=archive');
    await expect(page.getByRole('button', { name: /^archive/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('table', { name: 'Packages' }).locator('tr[data-package]')).toHaveCount(archived.length);

    // Enter in the search box submits the form's first button, which carries the status on screen.
    await page.getByRole('searchbox').fill('a');
    await page.getByRole('searchbox').press('Enter');
    await expect(page).toHaveURL(/status=archive/);
    await expect(page).toHaveURL(/q=a(&|$)/);

    const unknownStatus = await page.goto('/packages?status=bogus');
    expect(unknownStatus?.status()).toBe(200);
    await expect(page.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');

    const none = await page.goto('/packages?q=graphql');
    expect(none?.status()).toBe(200);
    await expect(page.getByText('No package matches')).toBeVisible();
    await expect(page.getByRole('link', { name: /Search error codes for/ })).toBeVisible();
  });

  test('/packages/dot/next shows the candidate banner with the next version', async ({ page }) => {
    expect(dot?.nextVersion).toBeTruthy();
    const response = await page.goto('/packages/dot/next');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: '@arki/dot' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: `candidate for v${dot?.nextVersion}` })).toBeVisible();
    // The header line names the version; the Release health heading repeats it.
    await expect(page.getByText(`for @arki/dot@${dot?.nextVersion}`).first()).toBeVisible();
    // The version list lives in a closed <details> picker; open it as a reader would.
    await page.locator('details.vpick > summary').click();
    await expect(page.getByRole('list', { name: 'Versions of @arki/dot' }).locator('a[aria-current="page"]')).toHaveText(
      new RegExp(`^${dot?.nextVersion}`),
    );
    await expect(page.getByRole('region', { name: /^Release health/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Public imports' })).toBeVisible();
  });

  test('an archived version says it is not supported', async ({ page }) => {
    const archived = dot?.versions.find(version => version.archive);
    test.skip(archived === undefined, 'dot has no archived snapshot');
    await page.goto(`/packages/dot/${archived?.version}`);
    await expect(page.getByRole('note').filter({ hasText: `${archived?.version} is archived.` })).toBeVisible();
  });

  test('a doc page renders by its path', async ({ page }) => {
    const response = await page.goto('/packages/dot/next/README');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('link', { name: `All docs for @arki/dot@${dot?.nextVersion}` })).toBeVisible();
  });

  // WHY: the journal's package page carries the homepage's journal chapter, working, and drawn with home.css's
  // own look inside the docs chrome. No other package page pays for its code or its stylesheet.
  test('/packages/journal shows the working journal chapter; /packages/dot loads none of it', async ({ page }) => {
    await page.goto('/packages/journal');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('@arki/journal');
    await expect(page.getByRole('complementary').getByRole('link', { name: 'How it works' })).toHaveAttribute(
      'href',
      '#walkthrough',
    );
    const chapter = page.locator('#walkthrough').getByRole('region', { name: 'The journal chapter' });
    const part = chapter.getByRole('group', { name: /A refund that waits/ });
    const rows = part.locator('tbody tr');
    await part.getByRole('button', { name: 'Reset' }).click();
    await expect(rows).toHaveText([/No rows yet/]);
    await part.getByRole('button', { name: 'Approve refund' }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('RefundApproved');
    // site.css's base table look (12px cells) must not reach into the drawing.
    await expect(rows.first().locator('td').first()).toHaveCSS('padding-left', '10px');

    await page.goto('/packages/dot');
    await expect(page.locator('.home-chapter')).toHaveCount(0);
    const chapterRules = await page.evaluate(() =>
      [...document.styleSheets].some(sheet => {
        try {
          return [...sheet.cssRules].some(rule => rule.cssText.includes('.home-chapter'));
        } catch {
          return false;
        }
      }),
    );
    expect(chapterRules, 'the chapter stylesheet loads only on /packages/journal').toBe(false);
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
