import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { FLOORS } from '../src/shared/marketing/floors';

/** The text of a code line: its tokens joined. */
const lineText = (line: (typeof FLOORS)[number]['code'][number]) => line.map(([, text]) => text).join('');

const workspaceFile = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

test.describe('/ construction sequence', () => {
  // WHY: the page promises that every floor builds only on the floors below it, so the sections must run foundation
  // first and show the quick-start line of the package that floor stands for.
  test('six floors, foundation first, each with its code lines', async ({ page }) => {
    await page.goto('/');
    const floors = page.locator('section[data-floor]');
    await expect(floors).toHaveCount(6);
    await expect(floors.locator('h2')).toHaveText(FLOORS.map(floor => floor.title));
    for (const [index, floor] of FLOORS.entries()) {
      const code = floors.nth(index).locator('pre');
      for (const line of floor.code) await expect(code).toContainText(lineText(line));
    }
  });

  // WHY: a code line shown as "copied from the README" must really be in that README, or the page misleads readers.
  test('every code line is copied exactly from the quick start it names', () => {
    for (const floor of FLOORS) {
      const readme = workspaceFile(floor.readme);
      for (const line of floor.code) expect(readme, `${floor.readme} has: ${lineText(line)}`).toContain(lineText(line));
    }
  });

  // WHY: readers pick a look once and expect the whole site to keep it; the choice must reach <html> and outlive a
  // reload, or every visit starts in the wrong mode.
  test('Candle dark sets the site theme and survives a reload', async ({ page }) => {
    await page.goto('/');
    const modes = page.getByRole('group', { name: 'Colour mode' });
    await expect(modes.getByRole('button')).toHaveText(['Light', 'Candle light', 'Candle dark', 'Dark']);
    await modes.getByRole('button', { name: 'Candle dark' }).click();
    const html = page.locator('html');
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(html).toHaveClass(/\bcandlelight\b/);
    await expect(modes.getByRole('button', { name: 'Candle dark' })).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(html).toHaveClass(/\bcandlelight\b/);
    await expect(modes.getByRole('button', { name: 'Candle dark' })).toHaveAttribute('aria-pressed', 'true');
  });

  // WHY: the elevation lights the floor you are reading; if scrolling never lit a floor, the drawing would be a
  // picture with no purpose.
  test('scrolling to a floor lights it in the elevation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.locator('section[data-floor="3"] h2').evaluate(heading => heading.scrollIntoView({ block: 'center' }));
    await expect(page.locator('.home-floor.is-now')).toHaveCount(1);
    await expect(page.locator('.home-floor.is-built')).toHaveCount(4);
  });

  test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });

    // WHY: the floors are the page; a reader without JavaScript (or before it loads) must still read all six and see
    // the elevation.
    test('every floor and its code line is on the page, with the elevation drawn', async ({ page }) => {
      await page.goto('/');
      const floors = page.locator('section[data-floor]');
      await expect(floors).toHaveCount(6);
      for (const [index, floor] of FLOORS.entries()) {
        await expect(floors.nth(index).locator('h2')).toBeVisible();
        for (const line of floor.code) await expect(floors.nth(index).locator('pre')).toContainText(lineText(line));
      }
      await expect(page.getByRole('img', { name: /^Side elevation/ })).toBeVisible();
      await expect(page.locator('.home-floor')).toHaveCount(6);
    });
  });
});
