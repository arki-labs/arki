import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type { Excerpt } from '../src/shared/marketing/excerpt';
import {
  ALL_EXCERPTS,
  BUILD_STEPS,
  DEFINE_APP,
  WAVES,
  WIRE_ERROR,
  WIRE_ERROR_SOURCE,
  WIRE_FIX,
  WIRE_MISTAKE,
  WIRE_MISTAKE_MARK,
} from '../src/shared/marketing/build-steps';
import { gapBefore } from '../src/shared/marketing/excerpt';
import { JOURNAL_PROOFS, JOURNAL_VERBS } from '../src/shared/marketing/journal-excerpts';
import {
  JOURNAL_NPM_VERSION,
  ORDER_EVENTS,
  RUN_START,
  SIGNAL,
  WORKFLOW_EVENTS,
} from '../src/shared/marketing/journal-lab';
import { MODEL_HEADLINE, MODEL_PARTS } from '../src/shared/marketing/model-excerpts';

const workspaceRoot = new URL('../../../../', import.meta.url);
const workspaceFile = (path: string) => readFileSync(new URL(path, workspaceRoot), 'utf8');
const fileLines = (path: string) => workspaceFile(path).split('\n');

// The page is server rendered and readable before React hydrates; a click or scroll before that is lost. Wait for the
// marker `__root.tsx` sets once every handler is attached.
const gotoHome = async (page: Page) => {
  await page.goto('/');
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
};

/** Every line of an excerpt, in the order shown. */
const linesOf = (excerpt: Excerpt) => excerpt.parts.flatMap(part => part.lines);

const expectExcerptShown = async (scope: Locator, excerpt: Excerpt) => {
  for (const line of linesOf(excerpt)) await expect(scope).toContainText(line);
};

/** A journal sheet by its number, such as `J-102`. */
const sheet = (page: Page, number: string) => page.locator(`#${number.toLowerCase()}`);
const tip = (page: Page) => page.locator('#glossary-tip');
const word = (page: Page, text: string) => page.locator('.home-code button.tk-term', { hasText: text }).first();

/**
 * The homepage with its journal chapter running. The chapter's code loads only when floor F4 comes near the screen,
 * so this scrolls there the way a reader does, then waits for the controls the code brings.
 */
const openJournal = async (page: Page) => {
  await gotoHome(page);
  await page.locator('#step-remember').evaluate(floor => floor.scrollIntoView());
  await expect(sheet(page, 'J-100').getByRole('button', { name: 'Reset' })).toBeVisible();
};

test.describe('/ build path', () => {
  // WHY: the page promises a build order (define, wire, feature, remember, serve, inspect), so the sections must run
  // in that order and show the real code of each step, or the "floors" are only decoration.
  test('six build steps in order, each with its excerpts', async ({ page }) => {
    await gotoHome(page);
    const steps = page.locator('section[data-floor]');
    await expect(steps).toHaveCount(6);
    await expect(steps.locator('h2')).toHaveText(BUILD_STEPS.map(step => step.title));
    for (const [index, step] of BUILD_STEPS.entries()) {
      // The Wire sheet opens on the mistake; the fixed line only appears when the reader asks for it.
      const shown = step.excerpts.filter(excerpt => excerpt !== WIRE_FIX);
      for (const excerpt of shown) await expectExcerptShown(steps.nth(index), excerpt);
    }
  });

  // WHY: the mental model band claims three ideas with real code behind each; the code must be on the page, or the
  // claims are only copy.
  test('the mental model band shows its three parts, each with its excerpt', async ({ page }) => {
    await gotoHome(page);
    const band = page.locator('section[aria-labelledby="home-model"]');
    await expect(band.locator('h2')).toHaveText(MODEL_HEADLINE);
    await expect(band.locator('.home-model > div > b')).toHaveText(MODEL_PARTS.map(part => part.name));
    for (const part of MODEL_PARTS) await expectExcerptShown(band, part.excerpt);
  });

  // WHY: a line shown as "copied from the file" must be on that line of that file, or the page misleads readers.
  test('every excerpt is copied exactly from the file and lines it names', () => {
    for (const excerpt of ALL_EXCERPTS) {
      for (const part of excerpt.parts) {
        const source = fileLines(part.path).slice(part.from - 1, part.from - 1 + part.lines.length);
        expect(source, `${part.path} line ${part.from}`).toEqual(part.lines);
      }
    }
  });

  // WHY: the sheet quotes a compiler error and the file that makes it; both must still say what the sheet says.
  test('the Wire error and the mistake come from the quickstart and define-app.ts', () => {
    const errorLines = fileLines(WIRE_ERROR.path).slice(
      WIRE_ERROR.from - 1,
      WIRE_ERROR.from - 1 + WIRE_ERROR.lines.length,
    );
    expect(errorLines).toEqual(WIRE_ERROR.lines);
    expect(workspaceFile(WIRE_ERROR_SOURCE.path)).toContain(WIRE_ERROR_SOURCE.message);
    expect(WIRE_ERROR.lines.join('\n')).toContain(WIRE_ERROR_SOURCE.message);
    expect(linesOf(WIRE_MISTAKE).join('\n')).toContain(WIRE_MISTAKE_MARK);
    expect(workspaceFile('packages/dot/src/lifecycle.ts')).toContain("ProviderMountedLater: 'ARKI_DOT_E020'");
  });

  // WHY: the simulation may only show names the journal really has, and every quote and proof must still be on the
  // line it names; a made-up name or a moved test would teach readers something false.
  test('journal benches use real names, quotes and test names', () => {
    const machine = workspaceFile('packages/journal/src/workflow/machine.ts');
    for (const event of WORKFLOW_EVENTS) expect(machine, event).toContain(`'${event}'`);
    const readme = workspaceFile('packages/journal/README.md');
    for (const event of Object.keys(ORDER_EVENTS)) expect(readme, event).toContain(`j.event('${event}'`);
    expect(fileLines('packages/journal/README.md')[1031]).toContain(`signal: '${SIGNAL}'`);
    expect(fileLines('packages/journal/README.md')[93]).toContain("j.projection('customer-stats'");
    const tables = workspaceFile('packages/journal/src/pg.ts');
    for (const name of ['journal_events', 'journal_jobs', 'journal_receipts', 'erased_at', 'event_seq', 'command_id'])
      expect(tables, name).toContain(`'${name}'`);
    expect(tables).toContain("attempts: integer('attempts')");
    for (const quote of [...JOURNAL_VERBS, ...Object.values(JOURNAL_PROOFS)]) {
      expect(fileLines(quote.path)[quote.line - 1], `${quote.path}:${quote.line}`).toContain(quote.text);
    }
    const catalog = workspaceFile('apps/arki/start/src/generated/packages.json');
    expect(catalog).toMatch(new RegExp(`"short": "journal",[^}]*"npmVersion": "${JOURNAL_NPM_VERSION}"`));
  });

  // WHY: "Built with arki" and the materials strip are claims about the repo; they must match it.
  test('the apps and packages the page names exist', () => {
    const catalog = workspaceFile('apps/arki/start/src/generated/packages.json');
    for (const wave of WAVES) {
      for (const name of wave.packages) {
        expect(catalog, `@arki/${name} is in packages.json`).toContain(`"short": "${name}"`);
        expect(
          () => readFileSync(new URL(`packages/${name}/package.json`, workspaceRoot)),
          `packages/${name}`,
        ).not.toThrow();
      }
    }
    const featuresDir = new URL('apps/avocabo/backend/src/features/', workspaceRoot);
    const featureCount = readdirSync(featuresDir).filter(name =>
      existsSync(new URL(`${name}/feature.ts`, featuresDir)),
    );
    expect(featureCount, 'avocabo features').toHaveLength(26);
  });

  // WHY: readers pick a look once and expect the whole site to keep it; the choice must reach <html> and outlive a
  // reload, or every visit starts in the wrong mode.
  test('Candle dark sets the site theme and survives a reload', async ({ page }) => {
    await gotoHome(page);
    const themes = page.getByRole('group', { name: 'Theme' });
    await expect(themes.getByRole('radio')).toHaveCount(4);
    const labels = await themes.locator('.home-swatch-label').allTextContents();
    expect(labels).toEqual(['Light', 'Candle light', 'Candle dark', 'Dark']);
    await themes.getByRole('radio', { name: /^Candle dark/ }).click();
    const html = page.locator('html');
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(html).toHaveClass(/\bcandlelight\b/);
    await expect(themes.getByRole('radio', { name: /^Candle dark/ })).toBeChecked();
    await page.reload();
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(html).toHaveClass(/\bcandlelight\b/);
    await expect(themes.getByRole('radio', { name: /^Candle dark/ })).toBeChecked();
  });

  // WHY: the picker must change the page, not only <html>'s class: each choice must be checked, put the matching
  // classes on <html> and repaint the page background.
  test('each theme is checked, sets its classes and repaints the page', async ({ page }) => {
    await gotoHome(page);
    const themes = page.getByRole('group', { name: 'Theme' });
    const classes: Record<string, string[]> = {
      Light: [],
      'Candle light': ['candlelight'],
      'Candle dark': ['dark', 'candlelight'],
      Dark: ['dark'],
    };
    const seen = new Set<string>();
    for (const [name, wanted] of Object.entries(classes)) {
      await themes.getByRole('radio', { name: new RegExp(`^${name}`) }).click();
      await expect(themes.getByRole('radio', { name: new RegExp(`^${name}`) })).toBeChecked();
      const html = page.locator('html');
      for (const word of ['dark', 'candlelight']) {
        await (wanted.includes(word)
          ? expect(html).toHaveClass(new RegExp(`\\b${word}\\b`))
          : expect(html).not.toHaveClass(new RegExp(`\\b${word}\\b`)));
      }
      await expect(page.locator('.home')).not.toHaveCSS('background-color', [...seen].at(-1) ?? 'none');
      seen.add(await page.locator('.home').evaluate(home => getComputedStyle(home).backgroundColor));
    }
    expect(seen.size).toBe(4);
  });

  // WHY: a radio group must work from the keyboard: arrow keys move the choice, and the page follows it.
  test('arrow keys move between the four themes', async ({ page }) => {
    await gotoHome(page);
    const themes = page.getByRole('group', { name: 'Theme' });
    await themes.getByRole('radio', { name: /^Light/ }).click();
    await expect(themes.getByRole('radio', { name: /^Light/ })).toBeChecked();
    await themes.getByRole('radio', { name: /^Light/ }).focus();
    await themes.getByRole('radio', { name: /^Light/ }).press('ArrowRight');
    await expect(themes.getByRole('radio', { name: /^Candle light/ })).toBeChecked();
    await expect(page.locator('html')).toHaveClass(/\bcandlelight\b/);
  });

  // WHY: with no stored choice the picker must show the mode the system resolved, or it would claim nothing is chosen.
  test('without a stored choice the picker marks the system mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoHome(page);
    await expect(page.getByRole('radio', { name: /^Dark/ })).toBeChecked();
  });

  // WHY: the swatches paint other modes than the one on screen, so they carry their own hex values; if the tokens
  // change and the swatches do not, the preview lies about the palette.
  test('swatch palettes match the design tokens', () => {
    const tokens = workspaceFile('apps/arki/start/src/styles/arki/tokens.css');
    const css = workspaceFile('apps/arki/start/src/styles/home.css');
    const blocks = {
      light: ':root',
      'candle-light': '.candlelight',
      'candle-dark': '.dark.candlelight',
      dark: '.dark',
    };
    for (const [mode, selector] of Object.entries(blocks)) {
      const body = tokens.split(new RegExp(`^${selector.replaceAll('.', '\\.')}\\s*\\{`, 'm'))[1]?.split('}')[0] ?? '';
      const swatch = css.split(`data-mode='${mode}'`)[1]?.split('}')[0] ?? '';
      for (const [token, property] of [
        ['background', '--sw-ground'],
        ['foreground', '--sw-ink'],
        ['primary', '--sw-accent'],
      ] as const) {
        const hex = new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`).exec(body)?.[1];
        expect(hex, `${mode} ${token}`).toBeDefined();
        expect(swatch.toLowerCase(), `${mode} ${property}`).toContain(`${property}: ${hex?.toLowerCase()}`);
      }
    }
  });

  // WHY: the elevation is the page's map; scrolling to a floor must light it AND bring the crane's bubble down to it,
  // or the drawing is a picture with no purpose. The page scrolls inside `.marketing`, so this scrolls like a reader.
  test('scrolling to a floor lights it and moves the bubble', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoHome(page);
    const bubble = page.locator('.home-load-bubble');
    const before = await bubble.boundingBox();
    await page.mouse.move(600, 400);
    await page.locator('section[data-floor="3"] h2').evaluate(heading => heading.scrollIntoView({ block: 'center' }));
    await expect(page.locator('.home-floor.is-now')).toHaveCount(1);
    await expect(page.locator('.home-floor.is-built')).toHaveCount(4);
    await expect(page.locator('.home-floor').nth(3)).toHaveClass(/is-now/);
    await expect(async () => {
      const after = await bubble.boundingBox();
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeGreaterThan(40);
    }).toPass();
    // Wheel back up by the whole distance scrolled: a fixed delta stops short once the floors above grow.
    const scrolled = await page.locator('.marketing').evaluate(scroller => scroller.scrollTop);
    await page.mouse.wheel(0, -scrolled);
    await expect(page.locator('.home-floor.is-now')).toHaveCount(0);
  });

  // WHY: the page scrolls inside `.marketing`, not the window, so only a real wheel over the page proves the
  // elevation follows what readers actually do.
  test('a real wheel scroll lights floors and moves the bubble', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoHome(page);
    await page.mouse.move(600, 400);
    const bubble = page.locator('.home-load-bubble');
    const start = await bubble.boundingBox();
    await page.mouse.wheel(0, 1800);
    await expect(page.locator('.home-floor.is-now')).toHaveCount(1);
    const first = await page
      .locator('.home-floor.is-now')
      .evaluate(floor => [...(floor.parentElement?.children ?? [])].indexOf(floor));
    await page.mouse.wheel(0, 2400);
    await expect(async () => {
      const next = await page
        .locator('.home-floor.is-now')
        .evaluate(floor => [...(floor.parentElement?.children ?? [])].indexOf(floor));
      expect(next).not.toBe(first);
    }).toPass();
    const end = await bubble.boundingBox();
    expect(Math.abs((end?.y ?? 0) - (start?.y ?? 0))).toBeGreaterThan(20);
  });

  // WHY: the journal floor is several screens tall. A bubble that moves only when another floor lights sat still
  // for all of it, and readers saw a crane that ignores their scroll. Every scroll must move it, even inside one floor.
  test('the bubble moves with the scroll inside one long floor', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoHome(page);
    await page.mouse.move(600, 400);
    // The crane's drop, not the bubble's box: the bubble image also drifts on its own, forever.
    const load = page.locator('.home-load');
    const journalFloor = page.locator('.home-floor').nth(3);
    await page.locator('section[data-floor="3"]').evaluate(floor => floor.scrollIntoView({ block: 'start' }));
    await expect(journalFloor).toHaveClass(/is-now/);
    const settledY = async () => {
      let last = Number.NaN;
      await expect(async () => {
        const y = await load.evaluate(group => new DOMMatrix(getComputedStyle(group).transform).f);
        const settled = y === last;
        last = y;
        expect(settled).toBe(true);
      }).toPass({ intervals: [300] });
      return last;
    };
    const before = await settledY();
    await page.mouse.wheel(0, 900);
    await expect(journalFloor).toHaveClass(/is-now/);
    const after = await settledY();
    expect(Math.abs(after - before)).toBeGreaterThan(4);
  });

  // WHY: on a phone the strip is the map: it must mark the floor in view and jump to a floor when tapped.
  test('on a 390px phone the strip marks the floor in view and jumps to a floor', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoHome(page);
    const strip = page.getByRole('navigation', { name: 'Build steps' });
    await expect(strip.getByRole('link')).toHaveCount(6);
    await page.locator('section[data-floor="3"] h2').evaluate(heading => heading.scrollIntoView({ block: 'center' }));
    await expect(strip.locator('[aria-current="step"]')).toHaveText('F4');
    await strip.getByRole('link', { name: /F2 Wire/ }).click();
    await expect(strip.locator('[aria-current="step"]')).toHaveText('F2');
    const top = await page.locator('#step-wire').evaluate(section => section.getBoundingClientRect().top);
    expect(top).toBeLessThan(200);
    expect(top).toBeGreaterThan(-5);
  });

  // WHY: motion must stop for readers who ask the system for less of it; the journal panes fade as they fill.
  test('reduced motion stills the journal pane fade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoHome(page);
    const pane = page.locator('.home-chapter .home-pane').first();
    await expect(pane).toBeVisible();
    // A global rule may shorten transitions to a hair above zero instead of none; either way nothing visibly fades.
    const seconds = await pane.evaluate(element => Number.parseFloat(getComputedStyle(element).transitionDuration));
    expect(seconds).toBeLessThan(0.01);
  });

  // WHY: a phone is the narrowest reader; code and the journal table must scroll inside their boxes, not the page.
  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    test(`no horizontal page scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await gotoHome(page);
      const overflow = await page.evaluate(() => {
        const scroller = document.querySelector('.marketing') ?? document.documentElement;
        return scroller.scrollWidth - scroller.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  // WHY: the header must stay one compact row on a phone with all its links reachable from the keyboard.
  test('the header is one compact row at 360px and its four links are reachable', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await gotoHome(page);
    const header = await page.locator('header.home-bar').boundingBox();
    expect(header?.height ?? 999).toBeLessThan(70);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link')).toHaveText(['Docs', 'Packages', "What's inside", 'GitHub']);
    await nav.getByRole('link', { name: 'GitHub' }).focus();
    await expect(nav.getByRole('link', { name: 'GitHub' })).toBeFocused();
  });

  // WHY: on a phone the title blocks sit under the drawings, the buttons are thumb-sized, and the journal tables
  // scroll inside their own boxes instead of widening the page.
  test('on a phone: title blocks below the drawings, thumb-sized buttons, tables scroll in their boxes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoHome(page);
    const draw = await page.locator('.home-draw').boundingBox();
    const block = await page.locator('.home-titleblock').boundingBox();
    expect(block?.y ?? 0).toBeGreaterThan((draw?.y ?? 0) + (draw?.height ?? 0) - 2);
    const toggle = await page.getByRole('button', { name: 'Put the database first' }).boundingBox();
    expect(toggle?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(toggle?.width ?? 0).toBeGreaterThan((draw?.width ?? 1) * 0.8);
    const sheet = page.locator('#j-104');
    const body = await sheet.locator('.home-jbody').boundingBox();
    const sheetBlock = await sheet.locator('.home-jblock').boundingBox();
    expect(sheetBlock?.y ?? 0).toBeGreaterThan((body?.y ?? 0) + (body?.height ?? 0) - 2);
    const ledger = sheet.locator('.home-ledger');
    const widths = await ledger.evaluate(box => ({ scroll: box.scrollWidth, client: box.clientWidth }));
    expect(widths.scroll).toBeGreaterThan(widths.client);
    for (const button of await page.locator('#j-101 .home-act').all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  // WHY: the marketing rules of this site: `expr`, `cas` and `bench` are never sold, and the journal's Dot adapters
  // stay off the page until an app uses them.
  test('unmarketed packages and claims appear nowhere on the page', async ({ page }) => {
    await gotoHome(page);
    const texts = await page.locator('body').allInnerTexts();
    const text = texts.join(' ');
    expect(text).not.toMatch(/\b(expr|cas|bench)\b/i);
    expect(text).not.toMatch(/react-hooks|journal\/dot|journal-flow|in production/i);
    expect(text).not.toMatch(/Temporal|Restate|Inngest|\bvs\.?\b|\bunlike\b/i);
    const links = await page
      .locator('a[href]')
      .evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href') ?? ''));
    expect(links.join(' ')).not.toMatch(/\/(expr|cas|bench)\b/);
  });

  test.describe('glossary words', () => {
    // WHY: the key API words explain themselves; hovering one must show its sentence, and Escape must close it.
    test('hovering waitFor shows its tooltip, and Escape closes it', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openJournal(page);
      await word(page, 'waitFor').scrollIntoViewIfNeeded();
      await word(page, 'waitFor').hover();
      await expect(tip(page)).toBeVisible();
      await expect(tip(page)).toContainText('Parks the run until the named signal arrives');
      await expect(tip(page)).toContainText('F4 · Remember');
      await page.keyboard.press('Escape');
      await expect(tip(page)).toBeHidden();
    });

    // WHY: keyboard readers must get the same explanation: Tab onto a word opens its tooltip.
    test('Tab reaches a glossary word and shows its tooltip', async ({ page }) => {
      await gotoHome(page);
      await expect(page.locator('button.tk-term').first()).toBeAttached();
      let focused = false;
      for (let press = 0; press < 80 && !focused; press += 1) {
        await page.keyboard.press('Tab');
        focused = await page.evaluate(() => document.activeElement?.classList.contains('tk-term') === true);
      }
      expect(focused, 'a glossary word took focus').toBe(true);
      await expect(tip(page)).toBeVisible();
      await expect(page.locator('.tk-term:focus')).toHaveAttribute('aria-describedby', 'glossary-tip');
    });

    // WHY: touch has no hover; a tap must open the tooltip, keep it on screen at 390px, and a tap elsewhere close it.
    test.describe('on a touch phone', () => {
      test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
      test('tapping waitFor opens its tooltip inside the screen; tapping elsewhere closes it', async ({ page }) => {
        await openJournal(page);
        await word(page, 'waitFor').scrollIntoViewIfNeeded();
        await word(page, 'waitFor').tap();
        await expect(tip(page)).toBeVisible();
        const box = await tip(page).boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 999)).toBeLessThanOrEqual(390);
        await page.locator('.home-hero h1').tap();
        await expect(tip(page)).toBeHidden();
      });
    });

    // WHY: selecting and copying code must give the exact source lines, buttons and colours included.
    test('copying a code block gives the excerpt text', async ({ page }) => {
      await gotoHome(page);
      const copied = await page
        .locator('#step-define .home-code')
        .nth(1)
        .locator('pre')
        .evaluate(pre => {
          const range = document.createRange();
          range.selectNodeContents(pre);
          const selection = getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return selection?.toString() ?? '';
        });
      // A gap in the source (imports to code, the chain's start to its end) is drawn, and copied, as one blank line (a
      // lone space in the markup, which the browser copies as a no-break space; both trim away). Imports run together.
      const lines = copied.split('\n').map(line => line.trimEnd());
      const expected = DEFINE_APP.parts
        .map((part, index) => (gapBefore(DEFINE_APP.parts[index - 1], part) ? '\n' : '') + part.lines.join('\n'))
        .join('\n');
      expect(lines.join('\n').trimEnd()).toBe(expected);
    });
  });

  test.describe('Wire sheet A-101', () => {
    // WHY: the toggle is the reader's proof that the order is a type: the wrong order shows the compiler error, and
    // putting the database first makes it go away.
    test('the toggle shows the wrong order with its error, then the right one', async ({ page }) => {
      await gotoHome(page);
      const sheet = page.getByRole('article', { name: 'Elevation: providers below consumers.' });
      const toggle = sheet.getByRole('button', { name: 'Put the database first' });
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect(sheet).toContainText(WIRE_MISTAKE_MARK);
      await expect(sheet).toContainText(WIRE_ERROR_SOURCE.message);
      await expect(sheet.getByRole('complementary', { name: 'Title block A-101' })).toContainText('1 · clouded');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expectExcerptShown(sheet, WIRE_FIX);
      await expect(sheet).not.toContainText(WIRE_ERROR_SOURCE.message);
      await expect(sheet).toContainText('The type error is gone');
      await toggle.click();
      await expect(sheet).toContainText(WIRE_ERROR_SOURCE.message);
    });
  });

  test.describe('journal chapter', () => {
    // WHY: J-100's promise: the row is its events replayed. A patch changes only its columns, and the replay pane
    // rebuilds an older version while the live row stays where it is.
    test('J-100: events patch the row, and the slider replays an older version', async ({ page }) => {
      await openJournal(page);
      const bench = sheet(page, 'J-100');
      await bench.getByRole('button', { name: 'Reset' }).click();
      await expect(bench.locator('.home-ledger tbody')).toContainText('No events yet');
      await bench.getByRole('button', { name: 'OrderPlaced' }).click();
      await bench.getByRole('button', { name: 'OrderPaid' }).click();
      const live = bench.locator('.home-pane').first();
      await expect(live.locator('td.is-hot')).toHaveText(['paid', '2']);
      const slider = bench.getByRole('slider', { name: /replay through version/ });
      await slider.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(bench.locator('.home-status')).toHaveText(
        'Replaying through version 1 of 2. The live row stays at version 2.',
      );
      await expect(bench.locator('.home-pane').nth(1)).toContainText('placed');
      await expect(live).toContainText('paid');
    });

    // WHY: J-101's first promise: cut the power before the commit and none of the four writes exist.
    test('J-101: pulling the plug mid-write leaves nothing, and no job to run', async ({ page }) => {
      await openJournal(page);
      const bench = sheet(page, 'J-101');
      await bench.getByRole('button', { name: 'Reset' }).click();
      await bench.getByRole('button', { name: 'Run payOrder' }).click();
      await bench.getByRole('button', { name: 'Pull the plug now' }).click();
      await expect(bench.locator('.home-tx-label')).toHaveText('one transaction · never committed');
      await expect(bench.locator('.home-tx .home-pane.is-empty')).toHaveCount(4);
      await expect(bench.locator('.home-fail')).toContainText('Postgres never got a commit');
      await expect(bench.getByRole('button', { name: 'Run the worker' })).toHaveCount(0);
    });

    // WHY: J-101's second promise: the job exists only after the commit, and a worker killed after the send runs it
    // again under the same id, so the inbox still holds one email.
    test('J-101: commit, kill the worker after the send, rerun: one email', async ({ page }) => {
      await openJournal(page);
      const bench = sheet(page, 'J-101');
      await bench.getByRole('button', { name: 'Reset' }).click();
      await bench.getByRole('button', { name: 'Run payOrder' }).click();
      await expect(bench.locator('.home-tx-label')).toHaveText('one transaction · committed', { timeout: 10_000 });
      await expect(bench.locator('.home-tx .home-pane.is-committed')).toHaveCount(4);
      await bench.getByRole('button', { name: 'Kill the worker after the email went out' }).click();
      await bench.getByRole('button', { name: 'Worker restarts, job runs again' }).click();
      await expect(bench).toContainText('attempts: 2');
      await expect(bench.locator('.home-mail')).toHaveCount(1);
      await expect(bench.locator('.home-okbox')).toContainText('same job id, one email');
    });

    // WHY: J-102's promise: three deliveries of one webhook run the handler once, write one event and get three
    // identical replies; the same key with another body is refused.
    test('J-102: three deliveries, one run, one event, identical replies', async ({ page }) => {
      await openJournal(page);
      const bench = sheet(page, 'J-102');
      await bench.getByRole('button', { name: 'Reset' }).click();
      await expect(bench).toContainText('runs: 0');
      for (let delivery = 0; delivery < 3; delivery += 1) {
        await bench.getByRole('button', { name: 'Deliver the webhook' }).click();
      }
      await expect(bench.locator('.home-num')).toHaveText('runs: 1');
      await expect(bench.locator('.home-evlist li')).toHaveCount(1);
      const replies = bench.locator('.home-ledger tbody tr td:nth-child(2)');
      await expect(replies).toHaveCount(3);
      expect(new Set(await replies.allTextContents()).size).toBe(1);
      await bench.getByRole('button', { name: 'Same key, different body' }).click();
      await expect(bench.locator('.home-fail')).toContainText('CommandConflict');
      await expect(bench.locator('.home-num')).toHaveText('runs: 1');
    });

    // WHY: J-103's promise: a hand edit is caught by verify, undone by repair, and forget keeps verify green.
    test('J-103: verify shows the drift, repair fixes it, forget stays green', async ({ page }) => {
      await openJournal(page);
      const bench = sheet(page, 'J-103');
      await bench.getByRole('button', { name: 'Reset' }).click();
      await bench.getByRole('button', { name: "set status = 'shipped'" }).click();
      await bench.getByRole('button', { name: /journal\.verify/ }).click();
      await expect(bench.locator('.home-pane').nth(1).locator('td.is-red')).toHaveText('shipped');
      await bench.getByRole('button', { name: /journal\.repair/ }).click();
      await expect(bench.locator('.home-pane').nth(1)).toContainText('{ ok: true }');
      await bench.getByRole('button', { name: /journal\.forget/ }).click();
      await expect(bench.locator('.home-ledger tbody tr').first()).toContainText('2026-10-21 14:02');
      await bench.getByRole('button', { name: /journal\.verify/ }).click();
      await expect(bench.locator('.home-status')).toHaveText(
        'Green after forget: the erased history still rebuilds the row.',
      );
    });

    // WHY: J-104's promise: a restart mid-step reruns it with the same key, so the provider refunds once; the sheet
    // is marked as not released yet.
    test('J-104: a restart during payBack still makes one refund, then the signal finishes the run', async ({
      page,
    }) => {
      await openJournal(page);
      const bench = sheet(page, 'J-104');
      await expect(bench.locator('.home-badge')).toContainText('not on npm yet');
      await bench.getByRole('button', { name: 'Reset' }).click();
      await bench.getByRole('button', { name: 'Start the refund' }).click();
      await bench.getByRole('button', { name: 'Restart the server now' }).click({ timeout: 10_000 });
      await expect(bench.locator('tr.is-srv')).toContainText('Nothing was written');
      await bench.getByRole('button', { name: 'Provider webhook: settled' }).click({ timeout: 10_000 });
      await expect(bench).toContainText('refund calls: 2');
      await expect(bench.locator('.home-val.is-hot')).toHaveText('1');
      await expect(bench.locator('.home-ledger tbody tr').last()).toContainText('RunCompleted');
    });

    // WHY: with the README's defaults a timeout parks the run for an operator; a cancel then undoes newest first.
    test('J-104: three days without a signal leave the run stuck; cancel undoes hold', async ({ page }) => {
      await openJournal(page);
      const bench = sheet(page, 'J-104');
      await bench.getByRole('button', { name: 'Reset' }).click();
      await bench.getByRole('button', { name: 'Start the refund' }).click();
      await bench.getByRole('button', { name: 'Wait 3 days' }).click({ timeout: 10_000 });
      await expect(bench.locator('.home-status')).toContainText('stuck until an operator');
      await bench.getByRole('button', { name: 'Cancel the run' }).click();
      await expect(bench.locator('.home-ledger tbody tr').last()).toContainText('RunCancelled');
      await expect(bench.locator('.home-undo li')).toHaveText([/payBack · no undo/, /hold · undo ran/]);
    });
  });

  test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });

    // WHY: the page is the build path; a reader without JavaScript (or before it loads) must still read every
    // floor, the A-101 sheet with its mistake and error, and every journal bench in a finished state.
    test('every floor, the sheet with its error and the five finished journal benches are on the page', async ({
      page,
    }) => {
      await page.goto('/');
      const steps = page.locator('section[data-floor]');
      await expect(steps).toHaveCount(6);
      for (const [index, step] of BUILD_STEPS.entries()) {
        await expect(steps.nth(index).locator('h2')).toBeVisible();
        for (const excerpt of step.excerpts.filter(candidate => candidate !== WIRE_FIX)) {
          await expectExcerptShown(steps.nth(index), excerpt);
        }
      }
      const sheet = page.locator('article.home-drawing');
      await expect(sheet).toContainText(WIRE_MISTAKE_MARK);
      await expect(sheet).toContainText(WIRE_ERROR_SOURCE.message);
      await expect(sheet.getByRole('button')).toHaveCount(0);
      const journal = page.getByRole('region', { name: 'The journal chapter' });
      await expect(journal.locator('section.home-jsheet')).toHaveCount(5);
      await expect(journal.getByRole('button')).toHaveCount(0);
      await expect(journal.getByRole('slider')).toHaveCount(0);
      await expect(journal.locator('#j-101 .home-tx .home-pane.is-committed')).toHaveCount(4);
      await expect(journal.locator('#j-102 .home-num')).toHaveText('runs: 1');
      await expect(journal.locator('#j-103 td.is-red')).toHaveText(['shipped', 'shipped']);
      await expect(journal.locator('#j-104 .home-ledger tbody tr')).toHaveCount(RUN_START.rows.length);
      await expect(page.getByRole('img', { name: /^Side elevation/ })).toBeVisible();
      await expect(page.locator('.home-floor')).toHaveCount(6);
    });
  });
});
