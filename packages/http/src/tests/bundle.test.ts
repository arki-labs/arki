/**
 * Bundle builder: immutable accumulation, stage order, mount
 * validation, and the compile-time context accumulation contract.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { BaseRequestCtx } from '../derive.js';
import { routes } from '../bundle.js';
import { route } from '../contract.js';
import { HTTP_ERROR_CODES } from '../error.js';
import { around, step } from '../middleware.js';
import { raw } from '../raw.js';

const ping = route.get('/ping', { id: 'ping', output: z.object({ ok: z.boolean() }) });
const bare = route.get('/bare', { id: 'bare' });
const download = route.get('/download', { id: 'download', output: raw() });

describe('routes() builder', () => {
  it('accumulates immutably — earlier builders are unchanged', () => {
    const empty = routes();
    const one = empty.bind(ping, () => ({ ok: true }));
    expect(empty.bindings).toHaveLength(0);
    expect(one.bindings).toHaveLength(1);
    expect(one.bindings[0]?.contract.id).toBe('ping');
  });

  it('records steps, arounds and mounts in declaration order', () => {
    const a = step(() => ({ a: 1 }));
    const wrap = around(<T>(_ctx: BaseRequestCtx, next: () => Promise<T>) => next());
    const b = step(() => ({ b: 2 }));
    const bundle = routes()
      .use(a)
      .use(wrap)
      .use(b)
      .mount('/rpc', () => new Response('rpc'), { id: 'rpc', transport: 'orpc' });

    // Order is the contract: an around wraps only the stages declared after it.
    expect(bundle.stages).toEqual([a, wrap, b]);
    expect(bundle.mounts[0]).toMatchObject({ id: 'rpc', path: '/rpc', transport: 'orpc' });
  });

  it('rejects malformed mount paths', () => {
    try {
      // @ts-expect-error -- a mount path must start with "/"
      routes().mount('rpc', () => new Response('x'), { id: 'rpc' });
      expect.unreachable('relative mount path must throw');
    } catch (error) {
      expect(error).toMatchObject({ code: HTTP_ERROR_CODES.invalidMount });
    }
  });

  it('types step-added context keys into later handlers', () => {
    routes()
      .use(step(() => ({ principal: { id: 'u1' } })))
      .bind(ping, (_input, ctx) => {
        const id: string = ctx.principal.id;
        expect(typeof id).toBe('string');
        return { ok: true };
      });

    routes().bind(ping, (_input, ctx) => {
      // @ts-expect-error — no step in this bundle adds "principal"
      void ctx.principal;
      return { ok: true };
    });
  });

  it('requires a Response only when the contract declares output: raw()', () => {
    routes().bind(download, () => new Response('fine'));
    // @ts-expect-error — a raw route returns a Response, not a plain value
    routes().bind(download, () => ({ ok: true }));
  });

  it('returns nothing when the contract declares no output (it answers 204)', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- the handler returns nothing on purpose: the route answers 204
    routes().bind(bare, () => undefined);
    // @ts-expect-error — plain values need an output schema to serialize against
    routes().bind(bare, () => ({ ok: true }));
    // @ts-expect-error — a Response needs output: raw()
    routes().bind(bare, () => new Response('fine'));
  });
});
