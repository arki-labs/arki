import { describe, expect, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import { defineStack, readManifest, service, StackManifestInvalid, StackNotStarted } from './index.js';

/** Counts what is up, so a test can say "nothing is left". */
function counted() {
  const live = new Set<string>();
  const shared = service<{ readonly id: string }>({
    name: 'shared',
    scope: 'run',
    async start(ctx) {
      live.add(`shared-${ctx.runId}`);
      return { value: { id: ctx.runId }, stop: async () => void live.delete(`shared-${ctx.runId}`) };
    },
  });
  const perWorker = service<null, { readonly port: number }>({
    name: 'perWorker',
    scope: 'worker',
    async start() {
      return { value: null, stop: () => Promise.resolve() };
    },
    async slice(_run, ctx) {
      const key = `worker-${ctx.workerIndex}`;
      live.add(key);
      return { value: { port: 9000 + ctx.workerIndex }, stop: async () => void live.delete(key) };
    },
  });
  const broken = service<{ readonly id: string }>({
    name: 'broken',
    scope: 'run',
    async start() {
      throw new Error('cannot start');
    },
  });
  return { live, shared, perWorker, broken };
}

describe('defineStack', () => {
  it('starts once, slices per worker, writes the env once, and stops everything', async () => {
    const { live, shared, perWorker } = counted();
    const stack = defineStack({
      services: { shared, perWorker },
      env: ({ shared, perWorker }, { origin }) => ({ RUN: shared.id, PORT: String(perWorker.port), ORIGIN: origin }),
    });
    const running = await stack.start({ runId: 'r1' });
    const w0 = await running.worker(0);
    const w1 = await running.worker(1);
    expect(w0.envFor('http://localhost:1')).toEqual({ RUN: 'r1', PORT: '9000', ORIGIN: 'http://localhost:1' });
    expect(w1.envFor('http://localhost:2').PORT).toBe('9001');
    expect([...live].toSorted()).toEqual(['shared-r1', 'worker-0', 'worker-1']);
    await w0.stop();
    await w1.stop();
    await running.stop();
    expect([...live]).toEqual([]);
  });

  it('lets a worker rebuild its slice from the manifest alone, as a Playwright worker does', async () => {
    const { shared, perWorker } = counted();
    const stack = defineStack({
      services: { shared, perWorker },
      env: ({ shared }) => ({ RUN: shared.id }),
    });
    const running = await stack.start({ runId: 'r2' });
    const manifest = orThrow(readManifest(JSON.stringify(running.manifest)));
    const slice = await stack.attach(manifest).worker(3);
    expect(slice.values.perWorker.port).toBe(9003);
    expect(slice.envFor('http://x').RUN).toBe('r2');
    await slice.stop();
    await running.stop();
  });

  it('stops the services already up when a later one fails to start', async () => {
    const { live, shared, broken } = counted();
    const stack = defineStack({ services: { shared, broken }, env: () => ({}) });
    await expect(stack.start({ runId: 'r3' })).rejects.toThrow('cannot start');
    expect([...live]).toEqual([]);
  });

  it('returns StackNotStarted for an empty env and StackManifestInvalid for any text that is not a manifest', () => {
    expect(StackNotStarted.is(readManifest(''))).toBe(true);
    expect(StackNotStarted.is(readManifest())).toBe(true);
    for (const text of ['{not json', '{"runId":1}', '[]', 'null', '{"runId":"r","run":[]}', '{"runId":"r","run":{"a":1e999}}']) {
      expect(StackManifestInvalid.is(readManifest(text)), text).toBe(true);
    }
    const good = readManifest('{"runId":"r","run":{"pg":{"url":"x","ports":[1,2]}}}');
    expect(isFailure(good)).toBe(false);
  });

  it('keeps stopping the other services when one stop rejects, then reports the error', async () => {
    const stopped: string[] = [];
    const mk = (name: string, fails: boolean) =>
      service<{ readonly name: string }>({
        name,
        scope: 'run',
        async start() {
          return {
            value: { name },
            stop: async () => {
              stopped.push(name);
              if (fails) throw new Error(`${name} stuck`);
            },
          };
        },
      });
    const stack = defineStack({ services: { a: mk('a', false), b: mk('b', true), c: mk('c', false) }, env: () => ({}) });
    const running = await stack.start({ runId: 'r4' });
    await expect(running.stop()).rejects.toThrow('b stuck');
    expect(stopped).toEqual(['c', 'b', 'a']);
  });

  it('stops every service even when several reject, and a failed start stops the ones already up', async () => {
    const stopped: string[] = [];
    const mk = (name: string, failStart = false) =>
      service<{ readonly name: string }>({
        name,
        scope: 'run',
        async start() {
          if (failStart) throw new Error('cannot start');
          return {
            value: { name },
            stop: async () => {
              stopped.push(name);
              throw new Error(`${name} stuck`);
            },
          };
        },
      });
    const both = defineStack({ services: { a: mk('a'), b: mk('b') }, env: () => ({}) });
    const running = await both.start({ runId: 'r5' });
    await expect(running.stop()).rejects.toBeInstanceOf(AggregateError);
    expect(stopped).toEqual(['b', 'a']);

    stopped.length = 0;
    const failing = defineStack({ services: { a: mk('a'), b: mk('b'), c: mk('c', true) }, env: () => ({}) });
    await expect(failing.start({ runId: 'r6' })).rejects.toThrow('cannot start');
    expect(stopped).toEqual(['b', 'a']);
  });
});
