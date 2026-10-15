/**
 * The Lua scripts of the Redis store. Each one is a single atomic step on the
 * server, so no client can see a half-done acquire or release. Keys come in
 * as `KEYS` (never built inside Lua), which keeps them in one cluster slot.
 *
 * No `DELEX ... IFEQ` here: that command needs Redis 8.4 and our floor is 7.
 */
import { createHash } from 'node:crypto';

/**
 * KEYS[1] lock key, KEYS[2] fence counter. ARGV[1] token, ARGV[2] ttl in ms.
 * Replies `{ fence, serverNowMs }` on success and `{ 0, 0 }` when held.
 * The fence is bumped only by a winner, in the same step as the win.
 *
 * The key already holding our own token is a win too: ioredis resends a
 * command whose reply was lost to a dropped connection, so this script can
 * run twice for one attempt. The second run gets the fence the first one
 * took (no other winner can have bumped it since) and a fresh ttl.
 */
export const ACQUIRE = `
local fence
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  fence = redis.call('INCR', KEYS[2])
elseif redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  fence = tonumber(redis.call('GET', KEYS[2])) or redis.call('INCR', KEYS[2])
else
  return { 0, 0 }
end
local time = redis.call('TIME')
return { fence, tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000) }
`;

/**
 * KEYS[1] lock key. ARGV[1] token, ARGV[2] wake channel.
 * Deletes the key only when the token matches, then wakes waiters.
 * Replies 1 when released, 0 when the caller is not the owner.
 * The channel is an ARGV, not a KEY: ioredis adds a client's `keyPrefix` to
 * KEYS but not to SUBSCRIBE, so a KEY channel would never reach the waiters.
 */
export const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('PUBLISH', ARGV[2], '1')
  return 1
end
return 0
`;

/**
 * KEYS[1] lock key. ARGV[1] token, ARGV[2] ttl in ms.
 * Resets the expiry only when the token matches. An expired key reads as
 * missing, so a lease that is gone is never revived. Replies 1 or 0.
 */
export const EXTEND = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

/*
 * Semaphore and read/write scripts. Every one reads the clock with `TIME` on the
 * server, never the caller's clock, and drops expired holders before it counts.
 * A holder is a member of a ZSET scored by its expiry in ms. The key that holds
 * the ZSET always gets a TTL equal to its latest expiry, so an abandoned lock
 * disappears. The fence counter is the exception: it never expires.
 */

const NOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/** Gives a ZSET (and optional companion key) a TTL up to its latest member expiry. */
const KEEP = `
local function keep(zset, other)
  local top = redis.call('ZREVRANGE', zset, 0, 0, 'WITHSCORES')
  if top[2] == nil then return end
  local left = math.max(tonumber(top[2]) - now, 1)
  redis.call('PEXPIRE', zset, left)
  if other ~= nil and redis.call('EXISTS', other) == 1 then redis.call('PEXPIRE', other, left) end
end
`;

/**
 * KEYS[1] holders ZSET (token scored by expiry), KEYS[2] meta HASH (`limit`, `w:<token>` weights and
 * `f:<token>` fences), KEYS[3] fence counter. ARGV[1] token, ARGV[2] ttl ms, ARGV[3] limit, ARGV[4] weight.
 * Replies `{ fence, serverNowMs }` on a grant, `{ 0, 0 }` when full, `{ -1, 0 }` when the stored
 * limit differs from ARGV[3] while live holders exist (a new limit is taken once none are left).
 * The token already holding a permit is a win again (a resent command): fresh expiry, and the fence it
 * was first given (stored as `f:<token>`), never the counter, which may belong to a later holder.
 */
export const PERMIT_ACQUIRE = `${NOW}${KEEP}
local dead = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, token in ipairs(dead) do
  redis.call('ZREM', KEYS[1], token)
  redis.call('HDEL', KEYS[2], 'w:' .. token, 'f:' .. token)
end
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[2]) end
local limit = tonumber(ARGV[3])
local stored = redis.call('HGET', KEYS[2], 'limit')
if stored and tonumber(stored) ~= limit then return { -1, 0 } end
local fence
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
  fence = tonumber(redis.call('HGET', KEYS[2], 'f:' .. ARGV[1])) or redis.call('INCR', KEYS[3])
else
  local used = 0
  local all = redis.call('HGETALL', KEYS[2])
  for i = 1, #all, 2 do
    if string.sub(all[i], 1, 2) == 'w:' then used = used + tonumber(all[i + 1]) end
  end
  if used + tonumber(ARGV[4]) > limit then return { 0, 0 } end
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
  fence = redis.call('INCR', KEYS[3])
  redis.call('HSET', KEYS[2], 'limit', ARGV[3], 'w:' .. ARGV[1], ARGV[4], 'f:' .. ARGV[1], fence)
end
keep(KEYS[1], KEYS[2])
return { fence, now }
`;

/**
 * KEYS[1] holders ZSET, KEYS[2] meta HASH. ARGV[1] token, ARGV[2] wake channel.
 * Removes a live holder owned by the token, then wakes waiters. Replies 1 or 0.
 * A holder whose expiry has passed is not an owner any more (as an expired mutex key is gone).
 */
export const PERMIT_RELEASE = `${NOW}
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], 'w:' .. ARGV[1], 'f:' .. ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[2]) end
if tonumber(score) <= now then return 0 end
redis.call('PUBLISH', ARGV[2], '1')
return 1
`;

/**
 * KEYS[1] holders ZSET, KEYS[2] meta HASH. ARGV[1] token, ARGV[2] ttl ms.
 * Moves a live holder's expiry to now + ttl. An expired holder is never revived. Replies 1 or 0.
 */
export const PERMIT_EXTEND = `${NOW}${KEEP}
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score or tonumber(score) <= now then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
keep(KEYS[1], KEYS[2])
return 1
`;

/**
 * KEYS[1] readers ZSET (token scored by expiry), KEYS[2] writer key (the writer's token, with a TTL),
 * KEYS[3] fence counter, KEYS[4] reader fences HASH (token -> the fence it was given). ARGV[1] token, ARGV[2] ttl ms, ARGV[3] 'read' or 'write'.
 * A reader wins when no writer is live; a writer wins when no writer and no reader is live.
 * Replies `{ fence, serverNowMs }` or `{ 0, 0 }`. The token already holding the lock wins again
 * (a resent command), with a fresh expiry and, for a reader, its own stored fence. Readers are never queued behind a waiting writer here.
 */
export const SHARED_ACQUIRE = `${NOW}${KEEP}
local dead = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, token in ipairs(dead) do
  redis.call('ZREM', KEYS[1], token)
  redis.call('HDEL', KEYS[4], token)
end
local fence
if ARGV[3] == 'read' then
  if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
    redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
    fence = tonumber(redis.call('HGET', KEYS[4], ARGV[1])) or redis.call('INCR', KEYS[3])
  elseif redis.call('EXISTS', KEYS[2]) == 1 then
    return { 0, 0 }
  else
    redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
    fence = redis.call('INCR', KEYS[3])
    redis.call('HSET', KEYS[4], ARGV[1], fence)
  end
  keep(KEYS[1], KEYS[4])
else
  if redis.call('GET', KEYS[2]) == ARGV[1] then
    redis.call('PEXPIRE', KEYS[2], ARGV[2])
    fence = tonumber(redis.call('GET', KEYS[3])) or redis.call('INCR', KEYS[3])
  elseif redis.call('EXISTS', KEYS[2]) == 1 or redis.call('ZCARD', KEYS[1]) > 0 then
    return { 0, 0 }
  else
    redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
    fence = redis.call('INCR', KEYS[3])
  end
end
return { fence, now }
`;

/**
 * KEYS[1] readers ZSET, KEYS[2] writer key, KEYS[3] reader fences HASH. ARGV[1] token, ARGV[2] wake channel.
 * Releases whichever hold the token owns (tokens are unique per attempt), then wakes waiters.
 * Replies 1 when released, 0 when the token owns no live hold.
 */
export const SHARED_RELEASE = `${NOW}
if redis.call('GET', KEYS[2]) == ARGV[1] then
  redis.call('DEL', KEYS[2])
  redis.call('PUBLISH', ARGV[2], '1')
  return 1
end
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if score then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[3], ARGV[1])
  if tonumber(score) > now then
    redis.call('PUBLISH', ARGV[2], '1')
    return 1
  end
end
return 0
`;

/**
 * KEYS[1] readers ZSET, KEYS[2] writer key, KEYS[3] reader fences HASH. ARGV[1] token, ARGV[2] ttl ms.
 * Renews the hold the token owns. An expired hold is never revived. Replies 1 or 0.
 */
export const SHARED_EXTEND = `${NOW}${KEEP}
if redis.call('GET', KEYS[2]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
  return 1
end
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score or tonumber(score) <= now then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
keep(KEYS[1], KEYS[3])
return 1
`;

/**
 * Read-only: would an acquire of ARGV[1] permits fit right now? KEYS[1] holders ZSET, KEYS[2] meta HASH.
 * Counts only holders whose expiry is still ahead. No limit stored (no live holder) means it fits.
 * Replies 1 or 0. Used by waiters to check after they subscribe, so a missed wake-up cannot strand them.
 */
export const PERMIT_FITS = `${NOW}
local limit = tonumber(redis.call('HGET', KEYS[2], 'limit'))
if not limit then return 1 end
local used = 0
for _, token in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. now, '+inf')) do
  used = used + tonumber(redis.call('HGET', KEYS[2], 'w:' .. token) or '0')
end
if used + tonumber(ARGV[1]) > limit then return 0 end
return 1
`;

/**
 * Read-only: would an acquire in mode ARGV[1] ('read' or 'write') succeed right now?
 * KEYS[1] readers ZSET, KEYS[2] writer key. Replies 1 or 0.
 */
export const SHARED_FITS = `${NOW}
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if ARGV[1] == 'write' and redis.call('ZCOUNT', KEYS[1], '(' .. now, '+inf') > 0 then return 0 end
return 1
`;

/** A script and the SHA-1 Redis knows it by (for `EVALSHA`). */
export type Script = { readonly source: string; readonly sha: string };

function script(source: string): Script {
  return { source, sha: createHash('sha1').update(source).digest('hex') };
}

export const acquireScript = script(ACQUIRE);
export const releaseScript = script(RELEASE);
export const extendScript = script(EXTEND);
export const permitAcquireScript = script(PERMIT_ACQUIRE);
export const permitReleaseScript = script(PERMIT_RELEASE);
export const permitExtendScript = script(PERMIT_EXTEND);
export const sharedAcquireScript = script(SHARED_ACQUIRE);
export const sharedReleaseScript = script(SHARED_RELEASE);
export const sharedExtendScript = script(SHARED_EXTEND);
export const permitFitsScript = script(PERMIT_FITS);
export const sharedFitsScript = script(SHARED_FITS);
