import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/** The feature sheet A-201 cuts open, in the app that has it. */
const WAITLIST = new URL('../../../avocabo/backend/src/features/waitlist/', import.meta.url);

/** The jobs `/docs` is ordered by (plan T3.3): readers arrive with a task, not a package name. */
const JOBS = ['Create an app', 'Add a feature', 'Inspect a failure', 'Deploy', 'Upgrade'];

test.describe('docs: jobs index, guides and glossary', () => {
  test('/docs lists the five jobs in order, each with a link, and every link resolves', async ({ page, request }) => {
    const response = await page.goto('/docs');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Docs' })).toBeVisible();
    await expect(page.getByText(/^For @arki\/dot@/)).toBeVisible();

    const jobs = page.getByTestId('doc-job');
    await expect(jobs.getByRole('heading', { level: 2 })).toHaveText(JOBS);
    for (const job of await jobs.all()) await expect(job.getByTestId('doc-job-link').first()).toBeVisible();

    const hrefs = await page
      .getByTestId('doc-job-link')
      .evaluateAll(links => links.map(link => link.getAttribute('href') ?? ''));
    for (const href of new Set(hrefs)) {
      const [pathname = '', hash] = href.split('#');
      const linked = await request.get(pathname);
      expect(linked.status(), href).toBe(200);
      if (hash !== undefined) {
        await page.goto(href);
        await expect(page.locator(`[id="${hash}"]`), href).toHaveCount(1);
      }
    }
  });

  test('/docs/guides lists guides; each shows its package version and ends with a command block', async ({ page }) => {
    await page.goto('/docs/guides');
    const links = page.getByTestId('guide-link');
    await expect(links.first()).toBeVisible();
    const hrefs = await links.evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href') ?? ''));

    // The "ends with" column shows the command a reader runs to check they are done: the last command of the guide.
    const checks = await page.getByTestId('guide-row').evaluateAll(rows =>
      rows.map(row => ({
        href: row.querySelector('a')?.getAttribute('href') ?? '',
        check: row.querySelector('[data-testid="guide-check"] code')?.textContent ?? null,
      })),
    );
    expect(checks.some(row => row.check !== null)).toBe(true);

    for (const href of hrefs) {
      const response = await page.goto(href);
      expect(response?.status(), href).toBe(200);
      if (href.startsWith('/packages/'))
        await expect(page.locator('article header').first()).toContainText('For @arki/');
      // The last section (the last H2) must hold a shell command: a guide ends with the step that checks the result.
      const endsWithCommand = await page
        .locator('article')
        .first()
        .evaluate(article => {
          const sections = article.querySelectorAll('h2');
          const commands = article.querySelectorAll(
            'pre[data-language="sh"], pre[data-language="bash"], pre[data-language="shell"]',
          );
          if (sections.length === 0 || commands.length === 0) return false;
          const lastSection = sections.item(sections.length - 1);
          const lastCommand = commands.item(commands.length - 1);
          return (lastSection.compareDocumentPosition(lastCommand) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        });
      expect(endsWithCommand, href).toBe(true);

      const shown = checks.find(row => row.href === href)?.check ?? null;
      const lastCommand = await page.evaluate(() => {
        const blocks = document.querySelectorAll(
          'pre[data-language="sh"], pre[data-language="bash"], pre[data-language="shell"]',
        );
        const lines = ([...blocks].at(-1)?.textContent ?? '')
          .split('\n')
          .map(line => line.trim())
          .filter(line => line !== '' && !line.startsWith('#'));
        return lines.at(-1) ?? null;
      });
      expect(shown, href).toBe(lastCommand);
    }
  });

  test('an unknown guide is a 404', async ({ page }) => {
    const response = await page.goto('/docs/guides/no-such-guide');
    expect(response?.status()).toBe(404);
  });

  // WHY: the guides index is a drawing set. Its A-000 index is the table of contents, so every sheet it lists must be
  // reachable, and the A-201 section must describe the room a reader presses, using the feature's real folders.
  test('/docs/guides: the A-000 index lists every guide and A-201, whose rooms describe themselves', async ({ page }) => {
    await page.goto('/docs/guides');
    const index = page.getByRole('navigation', { name: 'A-000 · Guide index' });
    await expect(index.locator('tbody tr')).toHaveCount((await page.getByTestId('guide-row').count()) + 1);
    await index.getByRole('link', { name: 'A-201' }).click();
    await expect(page).toHaveURL(/#a-201$/);
    const sheet = page.getByRole('article', { name: /cut the waitlist feature open/ });
    await expect(sheet).toBeInViewport();

    const rooms = sheet.locator('.home-room h4');
    await expect(rooms).toHaveText(['entrypoints', 'usecases', 'infra', 'model']);
    for (const room of await rooms.allTextContents()) expect(existsSync(new URL(room, WAITLIST)), room).toBe(true);

    const note = sheet.locator('.home-xnote');
    await expect(sheet.getByRole('button', { name: /^infra files/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(note).toContainText('The store binds db');
    await sheet.getByRole('button', { name: /^usecases files/ }).click();
    await expect(sheet.getByRole('button', { name: /^usecases files/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(sheet.getByRole('button', { name: /^infra files/ })).toHaveAttribute('aria-pressed', 'false');
    await expect(note).toContainText('never db or kv');
  });

  // WHY: without JavaScript the sheet is a drawing, not a set of dead buttons, and it still names one room.
  test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });
    test('/docs/guides draws A-201 with no buttons', async ({ page }) => {
      await page.goto('/docs/guides');
      const sheet = page.getByRole('article', { name: /cut the waitlist feature open/ });
      await expect(sheet.locator('.home-room')).toHaveCount(4);
      await expect(sheet.getByRole('button')).toHaveCount(0);
      await expect(sheet.locator('.home-xnote')).toContainText('The store binds db');
    });
  });

  test('/docs/glossary gives every term an anchor that resolves, and links only to site pages', async ({
    page,
    request,
  }) => {
    const response = await page.goto('/docs/glossary');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Glossary' })).toBeVisible();

    const rows = page.getByTestId('glossary').locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const ids = await rows.evaluateAll(elements => elements.map(element => element.id));
    expect(ids.every(id => id !== '')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) await expect(rows.locator(`th a[href="#${id}"]`)).toHaveCount(1);

    // Opening a deep link scrolls its term into view.
    const lastId = ids.at(-1) ?? '';
    await page.goto(`/docs/glossary#${lastId}`);
    await expect(page.locator(`[id="${lastId}"]`)).toBeInViewport();

    // Repo-only files (`.agents/…`, `CONTRIBUTING.md`) have no page on the site, so no link may point at them.
    const outbound = await page
      .getByTestId('glossary')
      .locator('a:not([href^="#"])')
      .evaluateAll(links => links.map(link => link.getAttribute('href') ?? ''));
    expect(outbound.length).toBeGreaterThan(0);
    for (const href of new Set(outbound)) {
      expect(href, href).not.toMatch(/\.agents|CONTRIBUTING|\.md(#|$)/);
      const linked = await request.get(href);
      expect(linked.status(), href).toBe(200);
    }
  });
});
