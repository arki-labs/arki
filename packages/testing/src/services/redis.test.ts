import { createConnection } from 'node:net';
import { expect } from 'vitest';

import { describeServiceContract } from '../stack/contract.js';
import { redis } from './redis.js';

/** One PING over a raw socket: the answer proves a real Redis is behind the URL. */
function ping(url: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: hostname, port: Number(port) }, () => socket.write('PING\r\n'));
    socket.once('data', data => {
      socket.end();
      resolve(data.toString().trim());
    });
    socket.once('error', reject);
  });
}

describeServiceContract({
  name: 'redis',
  make: () => redis(),
  probe: async worker => {
    expect(await ping(worker.url)).toBe('+PONG');
  },
  apart: async (a, b) => {
    expect(new URL(a.url).port).not.toBe(new URL(b.url).port);
  },
});
