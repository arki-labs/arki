import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { insideGroups } from '../src/features/inside/inside-data';

const workspaceRoot = new URL('../../../../', import.meta.url);
const rows = insideGroups.flatMap(group => [...group.rows]);
const newRows = rows.filter(row => row.new);
const shippedRows = rows.filter(row => row.state === 'shipped');

test.describe('/inside', () => {
  // WHY: the page promises every feature on six sheets; a lost or duplicated row would quietly break that promise.
  test('42 rows render in 6 sheets, each row in its own sheet', async ({ page }) => {
    await page.goto('/inside');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("What's inside");
    await expect(page.locator('.in-sheet')).toHaveCount(6);
    await expect(page.locator('.in-row')).toHaveCount(42);
    for (const group of insideGroups) {
      await expect(page.locator(`#${group.sheet} .in-row`)).toHaveCount(group.rows.length);
    }
  });

  // WHY: "New ideas only" is the reason a returning reader opens the page; it must hide everything else, and the
  // link must say that it is the active one.
  test('?show=new shows only new rows and marks its link', async ({ page }) => {
    await page.goto('/inside?show=new');
    await expect(page.locator('.in-row')).toHaveCount(newRows.length);
    await expect(page.locator('.in-row[data-new="false"]')).toHaveCount(0);
    const filters = page.getByRole('navigation', { name: 'Filter rows' });
    await expect(filters.getByRole('link', { name: 'New ideas only' })).toHaveAttribute('aria-current', 'page');
    await expect(filters.getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current', /.+/);
  });

  // WHY: "Shipped only" must never show a candidate or planned row, or a reader would try to install what is not on npm.
  test('?show=shipped shows only shipped rows', async ({ page }) => {
    await page.goto('/inside?show=shipped');
    await expect(page.locator('.in-row')).toHaveCount(shippedRows.length);
    await expect(page.locator('.in-row:not([data-state="shipped"])')).toHaveCount(0);
    const filters = page.getByRole('navigation', { name: 'Filter rows' });
    await expect(filters.getByRole('link', { name: 'Shipped only' })).toHaveAttribute('aria-current', 'page');
  });

  // WHY: a mistyped or old link must still give the reader the whole page, not an error.
  test('?show=bogus shows every row with status 200', async ({ page }) => {
    const response = await page.goto('/inside?show=bogus');
    expect(response?.status()).toBe(200);
    await expect(page.locator('.in-row')).toHaveCount(42);
    await expect(
      page.getByRole('navigation', { name: 'Filter rows' }).getByRole('link', { name: 'All' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  // WHY: the page says each code line is copied from the named file; opening a proof must show exactly those lines.
  test('a proof opens and its code equals the source excerpt', async ({ page }) => {
    await page.goto('/inside');
    const row = rows.find(candidate => candidate.proof?.path === 'packages/dot/src/define-app.ts');
    const proof = row?.proof;
    expect(proof).toBeTruthy();
    if (!proof) return;
    const [from = 0, to = from] = proof.lines.split('-').map(Number);
    const source = readFileSync(new URL(proof.path, workspaceRoot), 'utf8')
      .split('\n')
      .slice(from - 1, to)
      .join('\n');
    const details = page.locator('.in-proof', { hasText: proof.path }).first();
    await expect(details).not.toHaveAttribute('open', '');
    await details.locator('summary').click();
    await expect(details).toHaveAttribute('open', '');
    expect(await details.locator('code').evaluate(code => code.textContent)).toBe(source.replaceAll('\n', ''));
    expect(source).toBe(proof.code);
  });

  // WHY: the founder asked that this row say plainly that no app uses the Dot plugin yet, so nobody reads it as proven.
  test('the journal Dot plugin row says no app uses it yet', async ({ page }) => {
    await page.goto('/inside');
    const row = page.locator('.in-row', { hasText: 'The journal as a Dot plugin' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('No app uses it yet.');
    await expect(row).toContainText('packages/journal/src/dot.ts');
  });

  // WHY: the founder placed "What's inside" after Docs and Packages in both headers, and the current page must say so.
  for (const path of ['/', '/docs']) {
    test(`the header on ${path} lists Docs, Packages and What's inside`, async ({ page }) => {
      await page.goto(path);
      const links = page.locator('header nav a[href]').filter({ visible: true });
      for (const [name, href] of [
        ['Docs', '/docs'],
        ['Packages', '/packages'],
        ["What's inside", '/inside'],
      ] as const) {
        await expect(links.filter({ hasText: name }).first()).toHaveAttribute('href', href);
      }
    });
  }

  // WHY: the link of the current page must be marked for assistive tech, and the other main links must not be.
  test('the header marks /inside as the current page', async ({ page }) => {
    await page.goto('/inside');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: "What's inside" })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Docs' })).not.toHaveAttribute('aria-current', /.+/);
  });

  // WHY: the page is a reference; it must work for a reader or a crawler without JavaScript.
  test('without JavaScript every row shows and the filter links work', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/inside');
    await expect(page.locator('.in-row')).toHaveCount(42);
    await page.getByRole('navigation', { name: 'Filter rows' }).getByRole('link', { name: 'New ideas only' }).click();
    await page.waitForURL(/show=new/);
    await expect(page.locator('.in-row')).toHaveCount(newRows.length);
    await page.getByRole('navigation', { name: 'Sheets on this page' }).getByRole('link').nth(1).click();
    await expect(page).toHaveURL(/#I-102$/);
    await page.locator('.in-proof summary').first().click();
    await expect(page.locator('.in-proof[open]')).toHaveCount(1);
    await context.close();
  });

  // WHY: on a phone the code scrolls inside its own box; the page must never scroll sideways.
  test('at 360px nothing scrolls the page sideways, even with a proof open', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/inside');
    for (const summary of await page
      .locator('.in-proof summary')
      .all()
      .then(all => all.slice(0, 3)))
      await summary.click();
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.width);
  });

  // WHY: expr, cas and bench are internal; the founder keeps them off this page, in text and in links.
  test('expr, cas and bench appear nowhere', async ({ page }) => {
    await page.goto('/inside');
    const text = await page.locator('main').textContent();
    expect(text ?? '').not.toMatch(/\b(expr|cas|bench)\b/i);
    await expect(
      page.locator('a[href*="/packages/expr"], a[href*="/packages/cas"], a[href*="/packages/bench"]'),
    ).toHaveCount(0);
  });
});
