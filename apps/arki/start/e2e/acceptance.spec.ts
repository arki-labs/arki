import { gzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * Site acceptance checks (plan T3.9): the docs must work for keyboard users, on a 320px phone, with reduced motion,
 * without JavaScript, and without a heavy script download. Run against a built server (`bun run build`, then
 * `PORT=5181 bun .output/server/index.mjs`) so the numbers are production numbers.
 */

/** The docs pages a reader lands on. Detail pages use one real package, doc, guide and error code. */
const DOCS_PAGES = [
  '/docs',
  '/docs/guides',
  '/docs/glossary',
  '/docs/dot-new',
  '/docs/upgrade-story',
  '/packages',
  '/packages/dot',
  '/packages/dot/next/docs/quickstart',
  '/errors',
  '/errors/ARKI_ASYNC_E001',
  '/compare',
  '/agents',
];

/** Pages with code blocks or wide tables, the ones most likely to break a 320px screen. */
const WIDE_CONTENT_PAGES = [
  '/packages/dot',
  '/packages/dot/next/docs/quickstart',
  '/docs/dot-new',
  '/docs/glossary',
  '/errors/ARKI_ASYNC_E001',
  '/compare',
];

/** Plan T3.9: at most 200 KB of JavaScript (gzip) on a docs page. */
const JS_BUDGET_BYTES = 200 * 1024;

/** The links of the page's top navigation: the header's `nav` (main navigation or breadcrumb). */
function topNavLinks(page: Page) {
  return page.locator('header nav a[href]').filter({ visible: true });
}

/** Presses Tab until every top-nav link has had focus, or `limit` presses. Returns the hrefs never reached. */
async function unreachedByTab(page: Page, limit = 60): Promise<string[]> {
  const wanted = new Set(
    await topNavLinks(page).evaluateAll(links => links.map(link => link.getAttribute('href') ?? '')),
  );
  for (let press = 0; press < limit && wanted.size > 0; press += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLAnchorElement && active.closest('header nav') !== null
        ? active.getAttribute('href')
        : null;
    });
    if (focused !== null) wanted.delete(focused);
  }
  return [...wanted];
}

test.describe('site acceptance', () => {
  // WHY: a reader who cannot use a mouse must still reach every place the header offers, including the site nav
  // (Docs, Packages, Errors, Compare) at the top of every reference page.
  for (const path of ['/', '/docs', '/errors', '/packages/dot', '/packages/dot/next/docs/quickstart', '/docs/glossary']) {
    test(`keyboard alone reaches every top-nav item on ${path}`, async ({ page }) => {
      await page.goto(path);
      expect(await topNavLinks(page).count(), 'the page has a top nav').toBeGreaterThan(0);
      expect(await unreachedByTab(page)).toEqual([]);
    });
  }

  // WHY: the homepage is where most readers arrive; its header must lead straight to the reference sections, and a
  // keyboard user must be able to reach each of them.
  test('the homepage nav offers Docs, Packages, Errors and Compare to the keyboard', async ({ page }) => {
    await page.goto('/');
    const mainNav = page.getByRole('navigation', { name: 'Main navigation' });
    for (const [name, href] of [
      ['Docs', '/docs'],
      ['Packages', '/packages'],
      ['Errors', '/errors'],
      ['Compare', '/compare'],
    ] as const) {
      await expect(mainNav.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
    }
    expect(await unreachedByTab(page)).toEqual([]);
  });

  // WHY: code samples are what readers copy; on a 320px phone they must scroll inside their own box, not push the
  // whole page sideways.
  for (const path of WIDE_CONTENT_PAGES) {
    test(`code blocks and tables fit a 320px screen on ${path}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(path);
      const layout = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const blocks = [...document.querySelectorAll('pre')].map(pre => ({
          right: pre.getBoundingClientRect().right,
          scrolls: pre.scrollWidth <= pre.clientWidth || ['auto', 'scroll'].includes(getComputedStyle(pre).overflowX),
        }));
        return { width, pageWidth: document.documentElement.scrollWidth, blocks };
      });
      expect(layout.pageWidth, 'no page-level horizontal scroll').toBeLessThanOrEqual(layout.width);
      for (const block of layout.blocks) {
        expect(block.right).toBeLessThanOrEqual(layout.width);
        expect(block.scrolls, 'a long code line scrolls inside its block').toBe(true);
      }
    });
  }

  // WHY: on a phone the header must still offer its links (shown, or behind a menu button) without sideways scroll.
  // Only `/` has a top nav today; the docs pages' breadcrumb links are hidden below the `md` breakpoint (see the T3.9 report).
  for (const path of ['/']) {
    test(`mobile nav works on ${path}`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 740 });
      await page.goto(path);
      const toggle = page.locator('header button[aria-expanded]').first();
      if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
      const links = topNavLinks(page);
      expect(await links.count()).toBeGreaterThan(0);
      for (const link of await links.all()) {
        const box = await link.boundingBox();
        expect(box, 'nav link is on screen').not.toBeNull();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
      }
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(pageWidth).toBeLessThanOrEqual(375);
    });
  }

  // WHY: on a phone the breadcrumb hides its parent links, so a reader deep in the reference would be stuck on the
  // page. The site nav must stay on screen at 375px and lead back to the docs and the package list.
  for (const path of DOCS_PAGES.filter(page => /^\/(?:docs|packages|errors)(?:\/|$)/.test(page))) {
    test(`a phone reader on ${path} can reach /docs and /packages`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 740 });
      await page.goto(path);
      for (const href of ['/docs', '/packages']) {
        const link = topNavLinks(page).and(page.locator(`a[href="${href}"]`)).first();
        await expect(link, `a visible header link to ${href}`).toBeVisible();
        const box = await link.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0), `the ${href} link is on screen`).toBeLessThanOrEqual(375);
      }
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(pageWidth).toBeLessThanOrEqual(375);
    });
  }

  // WHY: readers who ask the system for less motion (vestibular disorders) must get no running animation and no
  // smooth scrolling.
  test.describe('with prefers-reduced-motion: reduce', () => {
    test.use({ colorScheme: 'light' });
    for (const path of ['/', '/docs', '/packages/dot', '/compare']) {
      test(`no animation runs on ${path}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const motion = await page.evaluate(() => ({
          running: document
            .getAnimations()
            .filter(animation => animation.playState === 'running')
            .map(animation => (animation instanceof CSSAnimation ? animation.animationName : animation.id || 'script')),
          scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        }));
        expect(motion.running).toEqual([]);
        expect(motion.scrollBehavior).not.toBe('smooth');
      });
    }
  });

  // WHY: docs are text; a reader with JavaScript off (or a slow phone before hydration) must still read them.
  test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });
    for (const path of DOCS_PAGES) {
      test(`${path} is readable`, async ({ page }) => {
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        await expect(page.locator('h1').first()).toBeVisible();
        const text = (await page.locator('main').textContent()) ?? '';
        expect(text.length).toBeGreaterThan(100);
      });
    }
  });

  // WHY: docs pages must load fast on a phone; the plan caps their JavaScript at 200 KB gzip.
  for (const path of DOCS_PAGES) {
    test(`JavaScript on ${path} stays within 200 KB gzip`, async ({ page }, testInfo) => {
      const scripts = new Map<string, number>();
      page.on('response', response => {
        if (response.request().resourceType() !== 'script') return;
        void response
          .body()
          .then(body => scripts.set(response.url(), gzipSync(body).length))
          .catch(() => null);
      });
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const total = [...scripts.values()].reduce((sum, size) => sum + size, 0);
      testInfo.annotations.push({
        type: 'js-gzip-bytes',
        description: `${path}: ${String(total)} bytes in ${String(scripts.size)} scripts`,
      });
      expect(scripts.size).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(JS_BUDGET_BYTES);
    });
  }
});
