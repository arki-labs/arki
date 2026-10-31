/**
 * The Redis search cache must only ever touch its own keys, and must never hand back a stored
 * value it has not checked.
 */
import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import type { RedisSearchClient } from './cache';
import { RedisSearchCache } from './cache';

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Redis `MATCH` semantics for `*`, `?`, `[...]` and `\\` escapes. */
function globMatches(glob: string, key: string): boolean {
  const chars = [...glob];
  let source = '';
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? '';
    switch (char) {
      case '\\': {
        source += escapeRegExp(chars[++index] ?? '');
        break;
      }
      case '*': {
        source += '.*';
        break;
      }
      case '?': {
        source += '.';
        break;
      }
      case '[': {
        const end = chars.indexOf(']', index);
        source += `[${escapeRegExp(chars.slice(index + 1, end).join(''))}]`;
        index = end;
        break;
      }
      default: {
        source += escapeRegExp(char);
      }
    }
  }
  return new RegExp(`^${source}$`).test(key);
}

/** An in-memory stand-in for the four Redis commands the cache uses, with glob `MATCH` like Redis. */
function memoryRedis(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  let scanned: string[] = [];
  const client: RedisSearchClient = {
    get: async key => store.get(key) ?? null,
    setex: async (key, _seconds, value) => {
      store.set(key, value);
      return 'OK';
    },
    // One key per page, to exercise the cursor loop. Like Redis, a scan walks the keys that existed when it began.
    scan: async (cursor, _match, pattern, _count, _size) => {
      if (cursor === '0') scanned = [...store.keys()];
      const page = Number(cursor);
      const next = page + 1 < scanned.length ? String(page + 1) : '0';
      return [next, scanned.slice(page, page + 1).filter(key => globMatches(pattern, key))];
    },
    del: async (...keys) => keys.filter(key => store.delete(key)).length,
  };
  return { client, store };
}

const listSchema = z.array(z.object({ id: z.string(), score: z.number() }));

describe('RedisSearchCache (F10)', () => {
  it('clear deletes only its own keys, never the rest of the database', async () => {
    // WHY: clear ran FLUSHDB and wiped every app key in the same Redis database.
    // `search1:x` is someone else's key that an unescaped `search[1]:*` pattern would match.
    const { client, store } = memoryRedis({ 'session:usr_1': 'keep', 'search1:x': 'keep' });
    const cache = new RedisSearchCache(client, { schema: listSchema, keyPrefix: 'search[1]:' });
    await cache.set('a', [{ id: 'a', score: 1 }]);
    await cache.set('b', [{ id: 'b', score: 2 }]);

    await cache.clear();

    expect([...store.keys()].sort()).toEqual(['search1:x', 'session:usr_1']);
  });

  it('round-trips a value through JSON and the schema', async () => {
    const { client } = memoryRedis();
    const cache = new RedisSearchCache(client, { schema: listSchema });

    await cache.set('q', [{ id: 'a', score: 0.5 }]);

    expect(await cache.get('q')).toEqual([{ id: 'a', score: 0.5 }]);
  });

  it('treats a stored value that is not JSON, or not the schema shape, as a miss', async () => {
    // WHY: a raw string used to come back cast to the caller's type.
    const { client } = memoryRedis({ 'arki:search-cache:text': 'not json', 'arki:search-cache:shape': '{"id":1}' });
    const cache = new RedisSearchCache(client, { schema: listSchema });

    expect(await cache.get('text')).toBeNull();
    expect(await cache.get('shape')).toBeNull();
  });
});
