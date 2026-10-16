/**
 * The HTTP response cache on Redis: `@arki/http/idempotency` stores a finished response here and
 * replays it when the same `Idempotency-Key` comes again.
 *
 * A redis adapter entry: it takes the `ioredis` client the app already has (the same type `KV`
 * uses for its rate limiter). `@arki/http` is an optional peer.
 *
 * Each key holds one string, `owner \n fingerprint \n response-json`; the third part is empty while the
 * request runs. `begin` is `SET NX PX`, so two first requests cannot both start. `finish` and
 * `abandon` are small Lua scripts that check the owner and write in one step, so a slow worker
 * whose key expired and was taken by another request cannot touch the new entry.
 * The TTL counts from `begin`; `finish` keeps the remaining time (`KEEPTTL`, Redis 6 or newer).
 */
import type { Redis } from 'ioredis';

import type { BeginResult, ResponseCache } from '@arki/http/idempotency';
import { storedResponse } from '@arki/http/idempotency';
import { parse } from '@arki/schema';

export type RedisResponseCacheOptions = {
  /** Prefix for every key. Default `idem:`. */
  readonly prefix?: string;
};

/** Set the response when the key still belongs to `owner`. ARGV: owner, response json. */
const FINISH = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local head = ARGV[1] .. '\\n'
if string.sub(value, 1, #head) ~= head then return 0 end
local rest = string.sub(value, #head + 1)
local newline = string.find(rest, '\\n', 1, true)
if not newline then return 0 end
redis.call('SET', KEYS[1], head .. string.sub(rest, 1, newline - 1) .. '\\n' .. ARGV[2], 'KEEPTTL')
return 1
`;

/** Delete the key when it still belongs to `owner`. ARGV: owner. */
const ABANDON = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local head = ARGV[1] .. '\\n'
if string.sub(value, 1, #head) ~= head then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

type Held = { readonly fingerprint: string; readonly response: string };

/** `owner \n fingerprint \n response`. The owner is a UUID and the fingerprint is hex, so neither holds a newline. */
const parseHeld = (value: string): Held | undefined => {
  const first = value.indexOf('\n');
  const second = value.indexOf('\n', first + 1);
  if (first === -1 || second === -1) return undefined;
  return { fingerprint: value.slice(first + 1, second), response: value.slice(second + 1) };
};

/** A {@link ResponseCache} on Redis. */
export function redisResponseCache(redis: Redis, options: RedisResponseCacheOptions = {}): ResponseCache {
  const prefix = options.prefix ?? 'idem:';

  return {
    async begin(key, fingerprint, owner, ttl): Promise<BeginResult> {
      const redisKey = prefix + key;
      // A key can expire between the `SET` and the `GET`; the second round settles that.
      for (let round = 0; round < 3; round += 1) {
        const set = await redis.set(redisKey, `${owner}\n${fingerprint}\n`, 'PX', Math.max(1, Math.ceil(ttl)), 'NX');
        if (set === 'OK') return 'started';
        const value = await redis.get(redisKey);
        if (value === null) continue;
        const held = parseHeld(value);
        if (held === undefined)
          throw new Error(`kv: idempotency key ${JSON.stringify(key)} holds a value this cache did not write`);
        if (held.fingerprint !== fingerprint) return 'conflict';
        if (held.response === '') return 'in-progress';
        return { replay: parse(storedResponse, JSON.parse(held.response)) };
      }
      throw new Error(`kv: idempotency key ${JSON.stringify(key)} kept changing while it was being claimed`);
    },

    async finish(key, owner, response) {
      await redis.eval(FINISH, 1, prefix + key, owner, JSON.stringify(response));
    },

    async abandon(key, owner) {
      await redis.eval(ABANDON, 1, prefix + key, owner);
    },
  };
}
