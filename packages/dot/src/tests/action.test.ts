import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Cancelled, Deadline, ScopeFailed } from '@arki/async';
import { defineFailure, InvalidInput, isFailure, reviveJson, serialize, UnexpectedDefect } from '@arki/failure';

import { action, ActionApprovalRequired, ActionNotExposed, ActionPrincipalRequired } from '../action.js';
import { bindAction } from '../execute.js';
import { defineApp } from '../index.js';
import { infra } from '../unit.js';

const ItemMissing = defineFailure('catalog.item_missing', { status: 404, data: z.object({ id: z.string() }) });
const CloseFailed = defineFailure('catalog.close_failed', { status: 503 });
const catalog = action({
  id: 'catalog.lookup',
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), title: z.string() }),
  failures: [ItemMissing, CloseFailed],
  policy: { exposure: ['http', 'rpc', 'worker'], principal: 'optional', approval: 'none', retry: 'never' },
});
const invocation = { binding: 'http', principal: 'anonymous', approval: 'absent' } as const;

describe('one owned action boundary', () => {
  it('publishes the existing ActionSource projection without binding or booting services', () => {
    const result = defineApp('catalog')
      .infra(infra({ name: 'catalog', actions: [catalog] }))
      .configure();
    if (isFailure(result)) throw new Error(result.code);
    expect(result.manifest.actions).toEqual([{ plugin: 'catalog', ...catalog.toDotAction() }]);
    expect(catalog).not.toHaveProperty('run');
  });

  it('validates input before invoking a service and validates server output as a defect', async () => {
    const service = vi.fn(({ id }: z.output<typeof catalog.input>) => ({ id, title: 'Typed apps' }));
    const bound = bindAction(catalog, service);
    expect(InvalidInput.is(await bound.run({ id: 42 }, invocation))).toBe(true);
    expect(service).not.toHaveBeenCalled();
    expect(await bound.run({ id: 'book' }, invocation)).toEqual({ id: 'book', title: 'Typed apps' });
    // An external implementation may violate its declared output schema at runtime.
    const strict = action({
      ...catalog,
      failures: [ItemMissing],
      output: z.object({ id: z.string(), title: z.string().min(1) }),
    });
    expect(
      UnexpectedDefect.is(await bindAction(strict, () => ({ id: 'book', title: '' })).run({ id: 'book' }, invocation)),
    ).toBe(true);
  });

  it('retains domain failure identity and safely round-trips the same canonical refs through worker JSON', async () => {
    const missing = ItemMissing({ id: 'absent' }, { cause: new Error('private database credentials') });
    const result = await bindAction(catalog, () => missing).run({ id: 'absent' }, invocation);
    expect(result).toBe(missing);
    const envelope = serialize(missing, catalog.failures);
    const json = JSON.stringify(envelope);
    expect(json).not.toContain('credentials');
    expect(reviveJson(json, catalog.failures)).toEqual(ItemMissing({ id: 'absent' }));
  });

  it('joins children before cleanup and retains a primary failure when release succeeds', async () => {
    const events: string[] = [];
    const missing = ItemMissing({ id: 'absent' });
    const bound = bindAction(catalog, async (_input, scope) => {
      const resource = await scope.acquire(
        () => ({ name: 'session' }),
        () => {
          events.push('close');
        },
      );
      if (isFailure(resource)) return resource;
      const child = scope.fork(async () => {
        await Promise.resolve();
        events.push('child');
      });
      if (isFailure(child)) return child;
      return missing;
    });
    expect(await bound.run({ id: 'absent' }, invocation)).toBe(missing);
    expect(events).toEqual(['child', 'close']);
  });

  it('returns an ordered aggregate when the operation and cleanup fail', async () => {
    const missing = ItemMissing({ id: 'absent' });
    const close = CloseFailed();
    const bound = bindAction(catalog, async (_input, scope) => {
      const resource = await scope.acquire(
        () => 'session',
        () => close,
      );
      return isFailure(resource) ? resource : missing;
    });
    const result = await bound.run({ id: 'absent' }, invocation);
    expect(ScopeFailed.is(result)).toBe(true);
    if (!ScopeFailed.is(result)) throw new Error('Expected aggregate');
    expect(result.data).toEqual({ primaryCount: 1, cleanupCount: 1 });
    expect(result.cause).toEqual({ primary: [missing], cleanup: [close] });
  });

  it('normalizes rejected implementations and owns cancellation before starting work', async () => {
    const cause = new Error('provider defect');
    const bound = bindAction(catalog, () => Promise.reject(cause));
    const result = await bound.run({ id: 'book' }, invocation);
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (UnexpectedDefect.is(result)) expect(result.cause).toBe(cause);
    const service = vi.fn(() => ({ id: 'book', title: 'Ready' }));
    const cancelled = await bindAction(catalog, service).run(
      { id: 'book' },
      { ...invocation, signal: AbortSignal.abort() },
    );
    expect(Cancelled.is(cancelled)).toBe(true);
    expect(service).not.toHaveBeenCalled();
  });

  it('enforces the same minimum authority for tools and internal jobs and never retries implicitly', async () => {
    const protectedAction = action({
      ...catalog,
      failures: [ItemMissing],
      policy: { exposure: ['mcp', 'worker'], principal: 'required', approval: 'required', retry: 'idempotent' },
    });
    const service = vi.fn(() => ItemMissing({ id: 'absent' }));
    const bound = bindAction(protectedAction, service);
    expect(ActionNotExposed.is(await bound.run({ id: 'absent' }, invocation))).toBe(true);
    expect(ActionPrincipalRequired.is(await bound.run({ id: 'absent' }, { ...invocation, binding: 'mcp' }))).toBe(true);
    expect(
      ActionApprovalRequired.is(
        await bound.run({ id: 'absent' }, { ...invocation, binding: 'worker', principal: 'authenticated' }),
      ),
    ).toBe(true);
    expect(service).not.toHaveBeenCalled();
    expect(
      ItemMissing.is(
        await bound.run({ id: 'absent' }, { binding: 'mcp', principal: 'authenticated', approval: 'granted' }),
      ),
    ).toBe(true);
    expect(service).toHaveBeenCalledTimes(1);
  });

  it.each(['signal', 'deadline'] as const)(
    'never starts business work after %s closes admission during async validation',
    async key => {
      const controller = new AbortController();
      const descriptor = action({
        ...catalog,
        failures: [ItemMissing],
        input: catalog.input.transform(async input => {
          await Promise.resolve();
          controller.abort();
          return input;
        }),
      });
      const service = vi.fn(({ id }: z.output<typeof descriptor.input>) => ({ id, title: 'Never started' }));
      const result = await bindAction(descriptor, service).run(
        { id: 'book' },
        { ...invocation, [key]: controller.signal },
      );
      expect((key === 'signal' ? Cancelled : Deadline).is(result)).toBe(true);
      expect(service).not.toHaveBeenCalled();
    },
  );
});
