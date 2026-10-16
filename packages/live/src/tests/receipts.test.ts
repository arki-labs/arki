/**
 * Receipts instead of raw transaction ids (scoped-hints plan, D4).
 *
 * Why these tests exist: `pg_current_xact_id()` is one counter for the whole
 * database. Frames used to carry it in decimal, so the gap between two ids a
 * client saw told it how many transactions ran in between, on tables it may
 * not read. A frame must carry only receipts; a receipt must equal what the
 * client's own mutation returned (`receipts.of(txid)`), or `awaitTxId` never
 * resolves; and it must depend on the secret, or anyone could compute it.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LiveManifest, TableTag } from '../index.js';
import { liveEndpoint } from '../http.js';
import { createLiveHub, LIVE_ERROR_CODES, liveReceipts } from '../index.js';
import { fakeSource } from '../testing.js';
import { RECEIPTS } from './fixtures.js';

const POSTS: TableTag = { schema: 'public', table: 'posts' };
const manifest: LiveManifest = [{ path: ['posts', 'list'], reads: [POSTS] }];
/** Past `Number.MAX_SAFE_INTEGER`, and a small one: both would show up in decimal. */
const TXIDS = ['9007199254740993', '901'] as const;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.unstubAllGlobals();
});

/** The raw text of a stream up to and including its first `change` frame. */
async function wireUntilChange(): Promise<string> {
  const source = fakeSource();
  const hub = createLiveHub({ source, limits: { batchMs: 1 }, receipts: RECEIPTS });
  await hub.start();
  source.emit({ kind: 'ready' });
  cleanups.push(() => hub.stop());
  const endpoint = liveEndpoint({ hub, manifest, authorize: () => Promise.resolve({}) });
  const response = await endpoint.fetch(new Request('http://live.test/api/live'));
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('no body');
  cleanups.push(() => reader.cancel());
  const decoder = new TextDecoder();
  let text = '';
  const first = await reader.read();
  text += decoder.decode(first.value, { stream: true });
  for (const txid of TXIDS) source.emit({ kind: 'change', tags: [POSTS], txid });
  await sleep(5);
  while (!text.includes('"kind":"change"')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

describe('frames carry receipts, never transaction ids', () => {
  it('no frame on the wire contains a decimal xid8; each receipt equals receipts.of(txid) of its own transaction', async () => {
    const wire = await wireUntilChange();
    for (const txid of TXIDS) expect(wire).not.toContain(txid);
    const change = wire
      .split('\n\n')
      .map(block => block.replace(/^data: /, ''))
      .find(data => data.includes('"kind":"change"'));
    expect(change).toBeDefined();
    const frame: unknown = JSON.parse(change ?? '{}');
    // What the mutations returned: the client matches its own write by equality.
    const own = await Promise.all(TXIDS.map(txid => RECEIPTS.of(txid)));
    expect(frame).toMatchObject({ kind: 'change', tags: [POSTS], txids: own });
    for (const receipt of own) expect(receipt).toMatch(/^[\w-]{22}$/);
  });

  it('a receipt depends on the secret and the app; one secret gives one receipt on every instance', async () => {
    const secret = 'one-secret-shared-by-every-instance-0001';
    const [a, b, otherSecret, otherApp] = await Promise.all([
      liveReceipts({ app: 'blog', secret }).of('901'),
      liveReceipts({ app: 'blog', secret }).of('901'),
      liveReceipts({ app: 'blog', secret: 'another-secret-of-at-least-32-chars-0002' }).of('901'),
      liveReceipts({ app: 'shop', secret }).of('901'),
    ]);
    expect(a).toBe(b);
    expect(otherSecret).not.toBe(a);
    expect(otherApp).not.toBe(a);
    // Fixed length whatever the id: the size of a receipt tells nothing about the counter.
    expect(await liveReceipts({ app: 'blog', secret }).of('18446744073709551615')).toHaveLength(a.length);
  });

  it('fails loud: a short secret or no WebCrypto throws E001 at once, a non-id rejects E004', async () => {
    expect(() => liveReceipts({ app: 'blog', secret: 'too-short' })).toThrow(
      expect.objectContaining({ code: LIVE_ERROR_CODES.config }),
    );
    await expect(RECEIPTS.of('')).rejects.toMatchObject({ code: LIVE_ERROR_CODES.protocol });
    await expect(RECEIPTS.of('-1')).rejects.toMatchObject({ code: LIVE_ERROR_CODES.protocol });
    // An engine with no WebCrypto: `crypto` without `subtle`.
    vi.stubGlobal('crypto', {});
    expect(() => liveReceipts({ app: 'blog', secret: 'a-secret-of-at-least-32-characters-01' })).toThrow(
      expect.objectContaining({ code: LIVE_ERROR_CODES.config }),
    );
  });

  it('a hub without receipts names no transaction at all', async () => {
    const source = fakeSource();
    const hub = createLiveHub({ source, limits: { batchMs: 1 } });
    await hub.start();
    source.emit({ kind: 'ready' });
    cleanups.push(() => hub.stop());
    const opened = await hub.open({ signal: new AbortController().signal });
    const feed = opened[Symbol.asyncIterator]();
    await feed.next();
    source.emit({ kind: 'change', tags: [POSTS], txid: '901' });
    const change = await feed.next();
    expect(change.value).toMatchObject({ kind: 'change', tags: [POSTS], txids: [] });
  });
});
