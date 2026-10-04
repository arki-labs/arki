import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFlow } from './flow';

describe('flow cancellation prevents overlapping generation', () => {
  afterEach(() => vi.useRealTimers());

  it('returns at the deadline without retrying work still stopping', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let attempts = 0;
    const flow = createFlow<{ done: boolean }, Record<string, never>>({
      start: 'generate',
      nodes: {
        generate: {
          id: 'generate', retries: 1, retryDelayMs: 0, timeoutMs: 10,
          run: async (_state, _context, signal) => {
            attempts += 1;
            order.push(`start:${attempts}`);
            if (attempts === 2) return { done: true };
            return new Promise((_, reject) => {
              signal?.addEventListener('abort', () => {
                order.push('abort:1');
                setTimeout(() => { order.push('stopped:1'); reject(new Error('Provider aborted')); }, 20);
              }, { once: true });
            });
          },
        },
      },
    });
    const result = flow.run({ done: false }, {});
    const rejected = expect(result).rejects.toThrow('Flow node failed');
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(order).toEqual(['start:1', 'abort:1']);
    await vi.runAllTimersAsync();
    expect(order).toEqual(['start:1', 'abort:1', 'stopped:1']);
    expect(attempts).toBe(1);
  });

  it.each(['timeout', 'cancel'])('bounds %s when work ignores abort and discards late success', async (kind) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const events: string[] = [];
    let finish: ((patch: { done: boolean }) => void) | undefined;
    const run = vi.fn(() => new Promise<{ done: boolean }>(resolve => { finish = resolve; }));
    const flow = createFlow<{ done: boolean }, Record<string, never>>({
      start: 'generate', signal: controller.signal,
      onEvent: event => events.push(event.type),
      nodes: { generate: { id: 'generate', retries: 2, timeoutMs: 10, run } },
    });
    const rejected = expect(flow.run({ done: false }, {})).rejects.toThrow('Flow node failed');
    if (kind === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(run).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe('flow:failed');
    finish?.({ done: true });
    await vi.runAllTimersAsync();
    expect(events).not.toContain('node:success');
    expect(events).not.toContain('flow:complete');
  });

  it('still retries settled ordinary failures', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('Temporary provider failure')).mockResolvedValue({ done: true });
    const flow = createFlow<{ done: boolean }, Record<string, never>>({
      start: 'generate',
      nodes: { generate: { id: 'generate', retries: 1, retryDelayMs: 0, run } },
    });
    await expect(flow.run({ done: false }, {})).resolves.toEqual({ done: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('aborts active work on user cancellation without retrying or accepting its late result', async () => {
    const controller = new AbortController();
    let attempts = 0;
    let stopped = false;
    const events: string[] = [];
    const flow = createFlow<{ done: boolean }, Record<string, never>>({
      start: 'generate', signal: controller.signal,
      onEvent: event => events.push(event.type),
      nodes: {
        generate: {
          id: 'generate', retries: 2,
          run: async (_state, _context, signal) => {
            attempts += 1;
            return new Promise(resolve => {
              signal?.addEventListener('abort', () => {
                stopped = true;
                resolve({ done: true });
              }, { once: true });
            });
          },
        },
      },
    });
    const result = flow.run({ done: false }, {});
    controller.abort();
    await expect(result).rejects.toThrow('Flow node failed');
    expect(stopped).toBe(true);
    expect(attempts).toBe(1);
    expect(events).not.toContain('node:success');
    expect(events).not.toContain('flow:complete');
  });
});
