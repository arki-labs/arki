import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type { Excerpt } from '../src/shared/marketing/build-steps';
import {
  ALL_EXCERPTS,
  BUILD_STEPS,
  DEFINE_APP,
  gapBefore,
  WAVES,
  WIRE_ERROR,
  WIRE_ERROR_SOURCE,
  WIRE_FIX,
  WIRE_MISTAKE,
  WIRE_MISTAKE_MARK,
} from '../src/shared/marketing/build-steps';
import { COMMAND_START, commandView, REFUND_START, refundRows } from '../src/shared/marketing/journal-model';

const workspaceRoot = new URL('../../../../', import.meta.url);
const workspaceFile = (path: string) => readFileSync(new URL(path, workspaceRoot), 'utf8');
const fileLines = (path: string) => workspaceFile(path).split('\n');

/** Every line of an excerpt, in the order shown. */
const linesOf = (excerpt: Excerpt) => excerpt.parts.flatMap(part => part.lines);

const expectExcerptShown = async (scope: Locator, excerpt: Excerpt) => {
  for (const line of linesOf(excerpt)) await expect(scope).toContainText(line);
};

const tip = (page: Page) => page.locator('#glossary-tip');
const word = (page: Page, text: string) => page.locator('.home-code button.tk-term', { hasText: text }).first();

test.describe('/ build path', () => {
  // WHY: the page promises a build order (define, wire, feature, remember, serve, inspect), so the sections must run
  // in that order and show the real code of each step, or the "floors" are only decoration.
  test('six build steps in order, each with its excerpts', async ({ page }) => {
    await page.goto('/');
    const steps = page.locator('section[data-floor]');
    await expect(steps).toHaveCount(6);
    await expect(steps.locator('h2')).toHaveText(BUILD_STEPS.map(step => step.title));
    for (const [index, step] of BUILD_STEPS.entries()) {
      // The Wire sheet opens on the mistake; the fixed line only appears when the reader asks for it.
      const shown = step.excerpts.filter(excerpt => excerpt !== WIRE_FIX);
      for (const excerpt of shown) await expectExcerptShown(steps.nth(index), excerpt);
    }
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

  // WHY: the simulation may only show events the workflow engine really writes, and only steps the refund workflow
  // really has; a made-up name would teach readers something false.
  test('journal rows use real event, step, signal and command names', () => {
    const machine = workspaceFile('packages/journal/src/workflow/machine.ts');
    const refund = workspaceFile('packages/payments/src/refunds/workflow.ts');
    const finished = refundRows({ stage: 'done', path: 'signal', retried: true, last: null });
    const timedOut = refundRows({ stage: 'done', path: 'timeout', retried: false, last: null });
    for (const row of [...finished, ...timedOut]) {
      if (row.kind === 'workflow') expect(machine, row.event).toContain(`'${row.event}'`);
      else expect(refund, row.event).toContain(row.event);
      if (row.event === 'NodeCompleted' || row.event === 'JobRetried')
        expect(refund, row.detail).toContain(`'${row.detail}'`);
      if (row.event === 'SignalReceived') expect(refund, row.detail).toContain(`'${row.detail}'`);
    }
    const readme = fileLines('packages/journal/README.md');
    expect(readme[75]).toContain('.on(OrderPaid');
    expect(readme[92]).toContain('customerStats');
    expect(readme[105]).toContain('orderMail');
    expect(fileLines('packages/payments/src/refunds/workflow.ts')[183]).toContain('completeRefund');
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
    await page.goto('/');
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
    await page.goto('/');
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
    await page.goto('/');
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
    await page.goto('/');
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
    await page.goto('/');
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
    await page.mouse.wheel(0, -4000);
    await expect(page.locator('.home-floor.is-now')).toHaveCount(0);
  });

  // WHY: the page scrolls inside `.marketing`, not the window, so only a real wheel over the page proves the
  // elevation follows what readers actually do.
  test('a real wheel scroll lights floors and moves the bubble', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
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
    await page.goto('/');
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
    await page.goto('/');
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

  // WHY: motion must stop for readers who ask the system for less of it; the journal row flash is the loudest motion.
  test('reduced motion stills the journal row highlight', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const part = page.getByRole('group', { name: /A refund that waits/ });
    await part.getByRole('button', { name: 'Reset' }).click();
    await part.getByRole('button', { name: 'Approve refund' }).click();
    const fresh = part.locator('tbody tr.is-new td').first();
    await expect(fresh).toBeVisible();
    await expect(fresh).toHaveCSS('animation-name', 'none');
  });

  // WHY: a phone is the narrowest reader; code and the journal table must scroll inside their boxes, not the page.
  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    test(`no horizontal page scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
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
    await page.goto('/');
    const header = await page.locator('header.home-bar').boundingBox();
    expect(header?.height ?? 999).toBeLessThan(70);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link')).toHaveText(['Docs', 'Packages', "What's inside", 'GitHub']);
    await nav.getByRole('link', { name: 'GitHub' }).focus();
    await expect(nav.getByRole('link', { name: 'GitHub' })).toBeFocused();
  });

  // WHY: on a phone the title block sits under the drawing, the toggle is a thumb-sized full-width button, and the
  // journal table turns into cards, or the sheet and the table would need sideways scrolling.
  test('on a phone: title block below the drawing, full-width toggle, ledger as cards', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const draw = await page.locator('.home-draw').boundingBox();
    const block = await page.locator('.home-titleblock').boundingBox();
    expect(block?.y ?? 0).toBeGreaterThan((draw?.y ?? 0) + (draw?.height ?? 0) - 2);
    const toggle = await page.getByRole('button', { name: 'Put the database first' }).boundingBox();
    expect(toggle?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(toggle?.width ?? 0).toBeGreaterThan((draw?.width ?? 1) * 0.8);
    await expect(page.locator('.home-ledger tbody tr').first()).toHaveCSS('display', 'grid');
    for (const button of await page
      .getByRole('group', { name: /Run a command/ })
      .locator('.home-act')
      .all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  // WHY: the marketing rules of this site: `expr`, `cas` and `bench` are never sold, and the journal's Dot adapters
  // stay off the page until an app uses them.
  test('unmarketed packages and claims appear nowhere on the page', async ({ page }) => {
    await page.goto('/');
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
      await page.goto('/');
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
      await page.goto('/');
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
        await page.goto('/');
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
      await page.goto('/');
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
      await page.goto('/');
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
    // WHY: Part 1 teaches "four writes or nothing": a run that commits must fill all four panes together.
    test('Part 1: Run, then Commit, fills the four panes together', async ({ page }) => {
      await page.goto('/');
      const part = page.getByRole('group', { name: /Run a command/ });
      const box = part.getByRole('group', { name: 'One transaction' });
      await part.getByRole('button', { name: 'Reset' }).click();
      await expect(box.locator('.home-pane.is-empty')).toHaveCount(4);
      await part.getByRole('button', { name: 'Run payOrder' }).click();
      await part.getByRole('button', { name: 'Next line' }).click();
      await expect(box.locator('.home-pane.is-staged')).toHaveCount(4);
      await expect(part.locator('.home-ln.is-on')).toContainText('return [OrderPaid({ amount: input.amount })]');
      await part.getByRole('button', { name: 'Commit' }).click();
      await expect(box.locator('.home-pane.is-committed')).toHaveCount(4);
      await expect(box).toContainText('OrderPaid { amount: input.amount }');
      await expect(box).toContainText('one transaction · committed');
    });

    // WHY: the other half of the promise: a rule that says no returns a typed failure, and nothing is written.
    test('Part 1: Make it fail writes nothing and returns CommandConflict as a value', async ({ page }) => {
      await page.goto('/');
      const part = page.getByRole('group', { name: /Run a command/ });
      const box = part.getByRole('group', { name: 'One transaction' });
      await part.getByRole('button', { name: 'Make it fail' }).click();
      await part.getByRole('button', { name: 'Run payOrder' }).click();
      await part.getByRole('button', { name: 'Next line' }).click();
      await expect(part.locator('.home-fail')).toContainText("CommandConflict({ detail: 'Order is already paid' })");
      await expect(part.locator('.home-ln.is-bad')).toContainText('CommandConflict');
      await expect(box.locator('.home-pane.is-empty')).toHaveCount(4);
      await expect(box).not.toContainText('OrderPaid {');
      await expect(part.getByRole('button', { name: 'Commit' })).toHaveCount(0);
    });

    // WHY: Part 2's claim is that a workflow is rows in the same table as the domain: after the webhook, one table
    // must hold both kinds, in the order the engine wrote them.
    test('Part 2: Approve to the Stripe webhook ends with domain and workflow rows in one table', async ({ page }) => {
      await page.goto('/');
      const part = page.getByRole('group', { name: /A refund that waits/ });
      const rows = part.locator('tbody tr');
      await part.getByRole('button', { name: 'Reset' }).click();
      await expect(rows).toHaveText([/No rows yet/]);
      await part.getByRole('button', { name: 'Approve refund' }).click();
      await expect(rows).toHaveCount(2);
      await part.getByRole('button', { name: 'Run step payBack' }).click();
      await part.getByRole('button', { name: "waitFor('settled')" }).click();
      await expect(part).toContainText('parked · timeout 3d');
      await part.getByRole('button', { name: 'Stripe webhook arrives' }).click();
      await expect(rows.last()).toContainText('SignalReceived · stripe.refund.settled');
      await part.getByRole('button', { name: 'Run step record' }).click();
      await expect(part).toContainText("RunCompleted · outcome: 'completed'");
      await expect(rows).toHaveCount(refundRows(REFUND_START).length);
      await expect(part.locator('tbody .home-kind span', { hasText: 'domain' }).first()).toBeVisible();
      await expect(part.locator('tbody .home-kind span', { hasText: 'workflow' }).first()).toBeVisible();
      await expect(rows.first()).toContainText('RefundApproved');
      await expect(rows.last()).toContainText('RunCompleted');
    });

    // WHY: a retried step is only safe because the key is the same on every try; the page must show the retry reuse it.
    test('Part 2: Retry keeps the same idempotency key', async ({ page }) => {
      await page.goto('/');
      const part = page.getByRole('group', { name: /A refund that waits/ });
      await part.getByRole('button', { name: 'Reset' }).click();
      await part.getByRole('button', { name: 'Approve refund' }).click();
      await part.getByRole('button', { name: 'Run step payBack' }).click();
      await expect(part.locator('.home-ln.is-on', { hasText: 'idempotencyKey: key' })).toBeVisible();
      await part.getByRole('button', { name: 'Retry this step' }).click();
      await expect(part.locator('tbody tr', { hasText: 'JobRetried · payBack' })).toContainText('same idempotencyKey');
      await expect(part.locator('.home-status')).toContainText('same key');
      await expect(part.getByRole('button', { name: 'Retry this step' })).toHaveCount(0);
    });

    // WHY: the timeout path is the other way out of a parked run; it must end at the same done state through `record`.
    test('Part 2: letting 3 days pass fires the timer and finishes through record', async ({ page }) => {
      await page.goto('/');
      const part = page.getByRole('group', { name: /A refund that waits/ });
      await part.getByRole('button', { name: 'Reset' }).click();
      await part.getByRole('button', { name: 'Approve refund' }).click();
      await part.getByRole('button', { name: 'Run step payBack' }).click();
      await part.getByRole('button', { name: "waitFor('settled')" }).click();
      await part.getByRole('button', { name: 'Let 3 days pass' }).click();
      await expect(part.locator('tbody tr').last()).toContainText('TimerFired · settled');
      await part.getByRole('button', { name: 'Run step record' }).click();
      await expect(part.locator('tbody')).toContainText('no signal: record asks Stripe with findRefund');
    });
  });

  test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });

    // WHY: the page is the build path; a reader without JavaScript (or before it loads) must still read every
    // floor, the A-101 sheet with its mistake and error, and the finished journal run.
    test('every floor, the sheet with its error and the finished journal run are on the page', async ({ page }) => {
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
      await expect(journal.locator('.home-pane.is-committed')).toHaveCount(4);
      await expect(journal.locator('tbody tr')).toHaveCount(refundRows(REFUND_START).length);
      await expect(journal.getByRole('button')).toHaveCount(0);
      expect(commandView(COMMAND_START).panes).toBe('committed');
      await expect(page.getByRole('img', { name: /^Side elevation/ })).toBeVisible();
      await expect(page.locator('.home-floor')).toHaveCount(6);
    });
  });
});
