import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { IdempotencyStore, IdempotentContext } from '../../src/orpc/idempotency';
import { idempotency } from '../../src/orpc/idempotency';
import { offlineSafe } from '../../src/orpc/offline-safe-marker';

const contract = {
  posts: {
    create: offlineSafe(oc.input(z.object({ title: z.string() })).output(z.object({ id: z.string() }))),
    rename: oc.input(z.object({ title: z.string() })).output(z.object({ id: z.string() })),
  },
};

/** A store over a Map, with spies, so each case can see what the middleware asked. */
function memoryStore(): IdempotencyStore & { readonly rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    find: vi.fn(async (key: string, path: string, userId: string) => rows.get(`${key}|${path}|${userId}`) ?? null),
    store: vi.fn(async (key: string, path: string, userId: string, response: unknown) => {
      rows.set(`${key}|${path}|${userId}`, response);
    }),
  };
}

/** Serves the contract with the middleware installed ONCE, as an app does. */
function serve(store: IdempotencyStore, context: IdempotentContext) {
  let runs = 0;
  const impl = implement(contract).$context<IdempotentContext>().use(idempotency(store));
  const router = impl.router({
    posts: {
      create: impl.posts.create.handler(() => ({ id: `post_${String(++runs)}` })),
      rename: impl.posts.rename.handler(() => ({ id: `post_${String(++runs)}` })),
    },
  });
  return { client: createRouterClient(router, { context }), runs: () => runs };
}

/** usr_1 signed in; a queued replay (a key) also carries usr_1 as Offline-Actor, as the client queue sends it. */
const signedIn = (headers: Record<string, string>): IdempotentContext => ({
  headers: new Headers('Idempotency-Key' in headers ? { 'Offline-Actor': 'usr_1', ...headers } : headers),
  session: { user: { id: 'usr_1' } },
});

describe('idempotency middleware', () => {
  it('a marked procedure replayed with the same key runs once and answers the stored output', async () => {
    const store = memoryStore();
    const { client, runs } = serve(store, signedIn({ 'Idempotency-Key': 'k1' }));

    const first = await client.posts.create({ title: 'A' });
    const replay = await client.posts.create({ title: 'A' });

    expect(replay).toEqual(first);
    expect(runs()).toBe(1);
    expect(store.find).toHaveBeenCalledWith('k1', 'posts.create', 'usr_1');
  });

  it('an unmarked procedure passes straight through, even with a key (it never touches the store)', async () => {
    const store = memoryStore();
    const { client, runs } = serve(store, signedIn({ 'Idempotency-Key': 'k1' }));

    await client.posts.rename({ title: 'A' });
    await client.posts.rename({ title: 'A' });

    expect(runs()).toBe(2);
    expect(store.find).not.toHaveBeenCalled();
  });

  it('no Idempotency-Key header: runs the handler every time', async () => {
    const store = memoryStore();
    const { client, runs } = serve(store, signedIn({}));

    await client.posts.create({ title: 'A' });
    await client.posts.create({ title: 'A' });

    expect(runs()).toBe(2);
    expect(store.find).not.toHaveBeenCalled();
  });

  it('no signed-in user: runs the handler (replays are scoped to a user)', async () => {
    const store = memoryStore();
    const { client, runs } = serve(store, { headers: new Headers({ 'Idempotency-Key': 'k1' }), session: null });

    await client.posts.create({ title: 'A' });

    expect(runs()).toBe(1);
    expect(store.find).not.toHaveBeenCalled();
  });

  // The browser checks the actor before sending, but the cookie can change
  // after that check. Only the server sees the session the request carries.
  describe('Offline-Actor: a replay runs only for the user who queued it', () => {
    it('queued by another user than the session: 403, the handler never runs', async () => {
      const { client, runs } = serve(memoryStore(), signedIn({ 'Idempotency-Key': 'k1', 'Offline-Actor': 'usr_2' }));
      await expect(client.posts.create({ title: 'A' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(runs()).toBe(0);
    });

    it('a replay with no Offline-Actor while signed in: 403 (missing never passes)', async () => {
      const context: IdempotentContext = { headers: new Headers({ 'Idempotency-Key': 'k1' }), session: { user: { id: 'usr_1' } } };
      const { client, runs } = serve(memoryStore(), context);
      await expect(client.posts.create({ title: 'A' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(runs()).toBe(0);
    });

    it('queued by a user but no session on the request: 403, never run anonymously', async () => {
      const context: IdempotentContext = { headers: new Headers({ 'Idempotency-Key': 'k1', 'Offline-Actor': 'usr_1' }), session: null };
      const { client, runs } = serve(memoryStore(), context);
      await expect(client.posts.create({ title: 'A' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(runs()).toBe(0);
    });

    it('a normal call (no key) needs no Offline-Actor', async () => {
      const { client, runs } = serve(memoryStore(), signedIn({}));
      await client.posts.create({ title: 'A' });
      expect(runs()).toBe(1);
    });
  });

  it('a store failure does not fail the call: the handler already ran and its answer is returned', async () => {
    const store = memoryStore();
    vi.mocked(store.store).mockRejectedValueOnce(new Error('db down'));
    const { client } = serve(store, signedIn({ 'Idempotency-Key': 'k1' }));

    await expect(client.posts.create({ title: 'A' })).resolves.toEqual({ id: 'post_1' });
  });
});
