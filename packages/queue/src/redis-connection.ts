import type { RedisOptions } from 'bullmq';

export type QueueConnection = string | (RedisOptions & { host: string; port: number });

/** Parse Redis URLs without dropping authentication, TLS, or database selection. */
export function parseRedisConnection(connection: QueueConnection): RedisOptions {
  if (typeof connection !== 'string') return connection;

  const url = new URL(connection);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('Queue connection must use redis:// or rediss://');
  }
  if (url.search || url.hash) {
    throw new Error('Queue connection URL query and fragment options are unsupported');
  }
  const port = url.port === '' ? 6379 : Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Queue connection requires a host and a valid port');
  }
  const database = url.pathname.slice(1);
  if (database !== '' && (!/^\d+$/.test(database) || !Number.isSafeInteger(Number(database)))) {
    throw new Error('Queue connection database must be a non-negative safe integer');
  }
  return {
    host: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: database === '' ? 0 : Number(database),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
