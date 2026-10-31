import { describe, expect, it } from 'vitest';

import { defineStack, service } from '../stack/index.js';
import { serveWorker } from './server.js';

function countedStack() {
  const live = new Set<number>();
  const probe = service<null, { readonly index: number }>({
    name: 'probe',
    scope: 'worker',
    async start() {
      return { value: null, stop: () => Promise.resolve() };
    },
    async slice(_run, ctx) {
      live.add(ctx.workerIndex);
      return { value: { index: ctx.workerIndex }, stop: async () => void live.delete(ctx.workerIndex) };
    },
  });
  return { live, stack: defineStack({ services: { probe }, env: () => ({}) }) };
}

describe('serveWorker', () => {
  it('stops the worker slice when the server never gets ready', async () => {
    const { live, stack } = countedStack();
    const running = await stack.start({ runId: 'serve-1' });
    await expect(
      serveWorker({
        stack: running,
        workerIndex: 2,
        serve: { command: ['node', '-e', 'process.exit(1)'], cwd: process.cwd(), readyPath: '/' },
        use: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/SERVER_NOT_READY/);
    expect([...live]).toEqual([]);
    await running.stop();
  });

  it('stops the slice and the server when the test body throws, and passes the slice values to it', async () => {
    const { live, stack } = countedStack();
    const running = await stack.start({ runId: 'serve-2' });
    const script =
      "require('node:http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')";
    let seenIndex: number | undefined;
    let url: string | undefined;
    await expect(
      serveWorker({
        stack: running,
        workerIndex: 5,
        serve: { command: ['node', '-e', script], cwd: process.cwd(), readyPath: '/' },
        use: async server => {
          seenIndex = server.values.probe.index;
          url = server.url;
          throw new Error('the test failed');
        },
      }),
    ).rejects.toThrow('the test failed');
    expect(seenIndex).toBe(5);
    expect([...live]).toEqual([]);
    await expect(fetch(url ?? '', { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    await running.stop();
  });
});
