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

/** A script and the SHA-1 Redis knows it by (for `EVALSHA`). */
export type Script = { readonly source: string; readonly sha: string };

function script(source: string): Script {
  return { source, sha: createHash('sha1').update(source).digest('hex') };
}

export const acquireScript = script(ACQUIRE);
export const releaseScript = script(RELEASE);
export const extendScript = script(EXTEND);
