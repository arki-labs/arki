/**
 * `@arki/live` end to end: a real TanStack Start app, real Postgres, real
 * Chromium. The app turns off every refetch TanStack Query does by itself
 * (focus, reconnect, mount, staleness), so a post can only reach a list
 * through the live stream: if live updates break, these specs fail.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';

import { expect, insertPost, test } from './fixtures';

/** Opens the page, waits for the stream and the first list, and marks the document so a reload shows. */
async function openLive(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('live-status')).toHaveText('live');
  // Attached, not visible: the first list may be empty, and an empty <ul> has no height.
  await expect(page.getByTestId('posts')).toBeAttached();
  await page.evaluate(() => {
    document.documentElement.dataset['noReload'] = 'kept';
  });
}

/** A reload or navigation would have dropped the mark: the update came in place. */
async function expectNoReload(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-no-reload', 'kept');
}

const postIn = (page: Page, title: string) => page.getByTestId('posts').getByText(title, { exact: true });

test('a post created in one tab shows up in the other tab without a reload', async ({ context }) => {
  // Why: the core promise. Tab A never asked for anything; only the hint the commit published
  // reached its stream and refetched its list. Tab B's mutation does not invalidate either, so
  // both tabs depend on the trigger -> NOTIFY -> hub -> SSE -> invalidation path.
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await openLive(tabA);
  await openLive(tabB);

  const title = `two tabs ${randomUUID()}`;
  await tabB.getByLabel('Title').fill(title);
  await tabB.getByRole('button', { name: 'Post' }).click();

  await expect(postIn(tabB, title)).toBeVisible();
  await expect(postIn(tabA, title)).toBeVisible();
  await expectNoReload(tabA);
});

test('a write committed while the tab was offline shows up once it is back online', async ({
  page,
  context,
  network,
  db,
}) => {
  // Why: a laptop lid or a train tunnel drops the stream, and the commit made meanwhile is never
  // sent to this tab. Back online, the client must reconnect with its cursor and the missed write
  // must reach the list (replayed or by a reset), with no reconnect refetch to paper over a miss.
  await openLive(page);

  await context.setOffline(true);
  network.dropConnections();
  await expect(page.getByTestId('live-status')).toHaveText('reconnecting');
  const title = `offline ${randomUUID()}`;
  await insertPost(db, title);

  await context.setOffline(false);
  await expect(page.getByTestId('live-status')).toHaveText('live');
  await expect(postIn(page, title)).toBeVisible();
  await expectNoReload(page);
});

test('after a server crash and restart the tab resets onto the new hub and shows the write made meanwhile', async ({
  page,
  server,
  db,
}) => {
  // Why: a deploy or a crash replaces the hub, so the tab's cursor names an epoch that no longer
  // exists. The new hub must answer it with a reset, which refetches every live query; otherwise
  // the commit made while the server was down never reaches the tab.
  await openLive(page);

  await server.kill();
  await expect(page.getByTestId('live-status')).toHaveText('reconnecting');
  const title = `restart ${randomUUID()}`;
  await insertPost(db, title);

  await server.start();
  // The client is in its backoff (up to 10 s, jittered) when the server returns.
  await expect(postIn(page, title)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('live-status')).toHaveText('live');
  await expectNoReload(page);
});
