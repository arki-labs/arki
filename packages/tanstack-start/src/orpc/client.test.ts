import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { oc } from '@orpc/contract';
import { createGeneralUtils, createTanstackQueryUtils } from '@orpc/tanstack-query';
import { describe, expect, it } from 'vitest';

import { createBackend, postsContract, servePosts } from './__fixtures__/posts';
import { createOrpcUtils } from './client';

const { client, orpc } = servePosts(createBackend());
const plain = createTanstackQueryUtils(client);

describe('createOrpcUtils', () => {
  it('retains own prototype-shaped children without changing group prototypes or query methods', async () => {
    const contract = { ['__proto__']: { ['__proto__']: oc }, constructor: oc };
    const client: ContractRouterClient<typeof contract> = createORPCClient({ call: () => Promise.resolve('result') });
    const utils = createOrpcUtils(contract, client);
    expect(Object.getPrototypeOf(utils)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(utils.__proto__)).toBe(Object.prototype);
    expect(Object.hasOwn(utils, '__proto__')).toBe(true);
    expect(Object.hasOwn(utils.__proto__, '__proto__')).toBe(true);
    expect(Object.keys(utils)).toEqual(['key', '__proto__', 'constructor']);
    expect(utils.__proto__.__proto__['~op']).toMatchObject({
      path: ['__proto__', '__proto__'],
      name: '__proto__.__proto__',
    });
    expect(utils.constructor['~op'].name).toBe('constructor');
    expect(utils.key()).toEqual(createGeneralUtils([]).key());
    expect(utils.__proto__.key()).toEqual(createGeneralUtils(['__proto__']).key());
    await expect(utils.__proto__.__proto__.call()).resolves.toBe('result');
    const serialized = JSON.stringify(utils);
    expect(serialized).toContain('"__proto__":{"__proto__":');
    expect(serialized).toContain('"name":"__proto__.__proto__"');
  });

  it('builds the same keys as oRPC, so both trees share one cache (no double fetch in a mixed app)', () => {
    const input = { status: 'published', limit: 5 };
    expect(orpc.posts.list.queryKey({ input })).toEqual(plain.posts.list.queryKey({ input }));
    const pageInput = (cursor: string | undefined) => ({ ...input, cursor });
    expect(orpc.posts.list.infiniteKey({ input: pageInput, initialPageParam: undefined })).toEqual(
      plain.posts.list.infiniteKey({ input: pageInput, initialPageParam: undefined }),
    );
    expect(orpc.posts.create.mutationKey()).toEqual(plain.posts.create.mutationKey());
    expect(orpc.posts.get.key({ type: 'query' })).toEqual(plain.posts.get.key({ type: 'query' }));
    expect(orpc.posts.key()).toEqual(plain.posts.key());
  });

  it('puts the operation on every leaf, and never on a group', () => {
    expect(orpc.posts.create['~op']).toEqual({ path: ['posts', 'create'], name: 'posts.create', meta: {} });
    expect(orpc.health.ping['~op'].name).toBe('health.ping');
    expect('~op' in orpc.posts).toBe(false);
    expect('~op' in orpc).toBe(false);
  });

  it('calls the procedure through the client it was given', async () => {
    await expect(orpc.posts.get.call({ id: 'p1' })).resolves.toEqual({ id: 'p1', title: 'From server' });
    await expect(orpc.health.ping.call()).resolves.toBe('pong');
  });

  it('fails loud on a contract key the utils would shadow', () => {
    const shadowed = { posts: { key: postsContract.posts.get } };
    const shadowedClient: ContractRouterClient<typeof shadowed> = createORPCClient({ call: () => Promise.resolve(null) });
    expect(() => createOrpcUtils(shadowed, shadowedClient)).toThrow(/reserved/);
  });
});
