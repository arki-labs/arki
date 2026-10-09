import { describe, expect, it } from 'vitest';

import { parseRedisConnection } from './redis-connection.ts';

describe('Redis connection URL semantics', () => {
  it('passes IPv6 addresses to Redis without URL brackets', () => {
    expect(parseRedisConnection('redis://[::1]:6380/2')).toMatchObject({ host: '::1', port: 6380, db: 2 });
  });
  it('preserves authenticated TLS connections and the selected database', () => {
    expect(parseRedisConnection('rediss://user%40tenant:p%3Ass%2Fword@redis.example:6380/12')).toEqual({
      host: 'redis.example',
      port: 6380,
      username: 'user@tenant',
      password: 'p:ss/word',
      db: 12,
      tls: {},
    });
  });

  it('uses Redis defaults when the URL omits port and database', () => {
    expect(parseRedisConnection('redis://localhost')).toEqual({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
    });
  });

  it('preserves existing object configuration', () => {
    const connection = { host: 'localhost', port: 6379, password: 'secret', db: 2, tls: {} };
    expect(parseRedisConnection(connection)).toBe(connection);
  });

  it.each([
    'https://localhost',
    'redis://localhost?db=2',
    'redis://localhost#options',
    'redis://localhost:0',
    'redis://localhost:65536',
    'redis://localhost:abc',
    'redis:///0',
    'redis://localhost/-1',
    'redis://localhost/1.5',
    'redis://localhost/1/2',
    'redis://localhost/9007199254740992',
    'redis://user:%zz@localhost',
  ])('rejects invalid connection %s before creating queues', connection => {
    expect(() => parseRedisConnection(connection)).toThrow();
  });
});
