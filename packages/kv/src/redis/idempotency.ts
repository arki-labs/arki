/**
 * The HTTP response cache on Redis: `@arki/http/idempotency` stores a finished response here and
 * replays it when the same `Idempotency-Key` comes again.
 *
 * A redis adapter entry: it takes the `ioredis` client the app already has (the same type `KV`
 * uses for its rate limiter). `@arki/http` is an optional peer.
 *
 * Each key holds one string, `owner \n fingerprint \n response-json`; the third part is empty while the
 * request runs. `begin` is `SET NX`, so two first requests cannot both start. `finish` and
 * `abandon` are small Lua scripts that check the owner and write in one step, so a slow worker
 * whose key was reconciled and reassigned cannot touch the new entry.
 * Pending reservations never expire. `finish` starts replay retention atomically with `SET PX`.
 */
import type { Redis } from 'ioredis';

import type { ResponseCache } from '@arki/http/idempotency';
import { isFailure } from '@arki/failure';
import {
  IdempotencyClaimUnconfirmed,
  IdempotencyOwnershipLost,
  IdempotencyReleaseUnconfirmed,
  IdempotencyReplayInvalid,
  IdempotencyWriteUnconfirmed,
  storedResponse,
} from '@arki/http/idempotency';
import { parse } from '@arki/schema';

export type RedisResponseCacheOptions = {
  /** Prefix for every key. Default `idem:`. */
  readonly prefix?: string;
};

/** Set the response when the key still belongs to `owner`. ARGV: owner, response json, TTL. */
const FINISH = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local head = ARGV[1] .. '\\n'
if string.sub(value, 1, #head) ~= head then return 0 end
local rest = string.sub(value, #head + 1)
local newline = string.find(rest, '\\n', 1, true)
if not newline then return -1 end
redis.call('SET', KEYS[1], head .. string.sub(rest, 1, newline - 1) .. '\\n' .. ARGV[2], 'PX', ARGV[3])
return 1
`;

/** Delete an unresolved key when it still belongs to `owner`. ARGV: owner. */
const ABANDON = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local head = ARGV[1] .. '\\n'
if string.sub(value, 1, #head) ~= head then return 0 end
local rest = string.sub(value, #head + 1)
local newline = string.find(rest, '\\n', 1, true)
if not newline then return -1 end
if string.sub(rest, newline + 1) ~= '' then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

/** `owner \n fingerprint \n response`. Owner and fingerprint never contain a newline. */
const parseHeld = (value: string) => {
  const first = value.indexOf('\n');
  const second = value.indexOf('\n', first + 1);
  if (first <= 0 || second <= first + 1) return;
  return { fingerprint: value.slice(first + 1, second), response: value.slice(second + 1) };
};

/** A response cache on Redis. Pending reservations have no TTL. */
export function redisResponseCache(redis: Redis, options: RedisResponseCacheOptions = {}): ResponseCache {
  const prefix = options.prefix ?? 'idem:';
  return {
    async begin(key, fingerprint, owner) {
      if (owner.length === 0 || owner.includes('\n') || fingerprint.length === 0 || fingerprint.includes('\n'))
        return IdempotencyClaimUnconfirmed();
      const redisKey = prefix + key;
      try {
        for (let round = 0; round < 3; round += 1) {
          const set: unknown = await redis.set(redisKey, `${owner}\n${fingerprint}\n`, 'NX');
          if (set === 'OK') return 'started';
          if (set !== null) return IdempotencyClaimUnconfirmed();
          const value = await redis.get(redisKey);
          if (value === null) continue;
          if (typeof value !== 'string') return IdempotencyClaimUnconfirmed();
          const held = parseHeld(value);
          if (held === undefined) return IdempotencyClaimUnconfirmed();
          if (held.fingerprint !== fingerprint) return 'conflict';
          if (held.response === '') return 'in-progress';
          try {
            const replay = parse(storedResponse, JSON.parse(held.response));
            if (isFailure(replay)) return IdempotencyReplayInvalid({ cause: replay });
            return { replay };
          } catch (error) {
            return IdempotencyReplayInvalid({ cause: error });
          }
        }
        return IdempotencyClaimUnconfirmed();
      } catch (error) {
        return IdempotencyClaimUnconfirmed({ cause: error });
      }
    },

    async finish(key, owner, response, ttl) {
      if (owner.length === 0 || owner.includes('\n')) return IdempotencyWriteUnconfirmed();
      if (!Number.isSafeInteger(ttl) || ttl <= 0) return IdempotencyWriteUnconfirmed();
      try {
        const result = await redis.eval(FINISH, 1, prefix + key, owner, JSON.stringify(response), ttl);
        if (result === 0) return IdempotencyOwnershipLost();
        if (result !== 1) return IdempotencyWriteUnconfirmed();
      } catch (error) {
        return IdempotencyWriteUnconfirmed({ cause: error });
      }
      return;
    },

    async abandon(key, owner) {
      if (owner.length === 0 || owner.includes('\n')) return IdempotencyReleaseUnconfirmed();
      try {
        const result = await redis.eval(ABANDON, 1, prefix + key, owner);
        if (result !== 0 && result !== 1) return IdempotencyReleaseUnconfirmed();
      } catch (error) {
        return IdempotencyReleaseUnconfirmed({ cause: error });
      }
      return;
    },
  };
}
