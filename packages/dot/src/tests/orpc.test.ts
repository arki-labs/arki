/**
 * `@arki/dot/orpc` — `bind(core)` and `rpc(contract, os, factories)`.
 *
 * Why these tests exist: a feature's handlers must get exactly what the
 * feature declared (needs, private infra, usecases) and nothing more, typed,
 * without the request context carrying it; a feature's router must implement
 * its contract, or the browser's contract client lies; and the usecase and
 * procedure files must reach `Deps` / `os` without a runtime import of the
 * feature, or the module graph has a cycle that dies with a TDZ error at import.
 *
 * The fixture under `fixtures/rpc-app/` is laid out like a real app.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { oc } from '@orpc/contract';
import { os as bare, createRouterClient, implement } from '@orpc/server';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { ServicesBag } from '../feature.js';
import type { RequestContext } from './fixtures/rpc-app/orpc.js';
import { defineFeature, FEATURE_ERROR_CODES, routerFor } from '../feature.js';
import { defineApp } from '../index.js';
import { needsMiddleware, rpc } from '../orpc.js';
import { core, digest } from './fixtures/rpc-app/digest/feature.js';
import { billing, database } from './fixtures/rpc-app/infra.js';
import { bind } from './fixtures/rpc-app/orpc.js';

const appContract = { digest: digest.contract };
const appRouter = implement(appContract)
  .$context<RequestContext>()
  .router(routerFor(appContract, [digest]));

/** What the gateway does per request: the session, the headers, and the services bag. */
const clientFor = (services: ServicesBag, userId: string | null = 'u1') =>
  createRouterClient(appRouter, {
    context: { session: userId === null ? null : { user: { id: userId } }, headers: new Headers(), services },
  });

const start = () => defineApp('rpc').infra(database, billing).features([digest]).start();

describe('bind(core): the handler context is what the feature declared', () => {
  it('runs a procedure through the needs, the private store and the usecases, all typed', async () => {
    const app = await start();
    // u1 is on the pro plan: the usecase reads the plan (a need) and the store (private infra).
    expect(await clientFor(app.services).digest.preview()).toEqual({
      id: 'd_2',
      items: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    const free = await clientFor(app.services, 'u2').digest.preview();
    expect(free?.items).toHaveLength(3);
    await app.dispose();
  });

  it('keeps the request context: `authed` after `bind` still narrows the session', async () => {
    const app = await start();
    await expect(clientFor(app.services, null).digest.preview()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await app.dispose();
  });

  it('types usecases from the factory, written once', () => {
    const probe = implement(digest.contract)
      .$context<RequestContext>()
      .use(bind(core))
      .preview.handler(({ context }) => {
        expectTypeOf(context.usecases.preview).returns.resolves.toHaveProperty('items');
        expectTypeOf(context.plans.planOf).parameter(0).toEqualTypeOf<string>();
        expectTypeOf(context.session).toEqualTypeOf<RequestContext['session']>();
        return null;
      });
    expect(probe).toBeDefined();
  });

  it('names the alias when the services bag lacks a handle, instead of a handler crashing on undefined', async () => {
    const failure: unknown = await clientFor({})
      .digest.preview()
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: FEATURE_ERROR_CODES.missingCapability });
    expect(String(failure)).toContain('"plans"');
  });

  it('refuses at compile time an alias that would shadow a request-context key', () => {
    type TracedContext = RequestContext & { readonly requestId: string };
    const tracedBind = needsMiddleware<TracedContext>();
    const shadowing = defineFeature('traced').needs({ requestId: billing.provides.entitlements });
    // @ts-expect-error -- the bound `requestId` would replace the request's own
    const refused = () => tracedBind(shadowing);
    expect(refused).toBeTypeOf('function');
  });
});

describe('rpc(contract, os, factories): one factory per procedure, keys match the contract', () => {
  const contract = oc.router({
    ping: oc.output(z.number()),
    admin: { count: oc.output(z.number()), reset: oc.output(z.string()) },
  });
  const other = oc.router({ pong: oc.output(z.string()) });
  const implemented = implement(contract).$context<RequestContext>();
  type Os = typeof implemented;
  const ping = (o: Os) => o.ping.handler(() => 1);
  const count = (o: Os) => o.admin.count.handler(() => 2);
  const reset = (o: Os) => o.admin.reset.handler(() => 'done');

  it('builds the router from the factories, a group as a nested object, and exposes it to routerFor', async () => {
    const entry = rpc(contract, implemented, { ping, admin: { count, reset } });
    expect(entry).toMatchObject({ kind: 'rpc', key: 'rpc', contract });
    expect(entry.resolve({})).toBe(entry.router);
    // Each leaf got the implementer: the built router answers like a hand-written one.
    const client = createRouterClient(entry.router, {
      context: { session: null, headers: new Headers(), services: {} },
    });
    expect(await client.ping()).toBe(1);
    expect(await client.admin.reset()).toBe('done');
  });

  it('rejects an extra key, a missing key, a wrong procedure under a key and a bare procedure', () => {
    const refused = () => {
      // @ts-expect-error -- `extra` is not in the contract
      rpc(contract, implemented, { ping, admin: { count, reset }, extra: ping });
      // @ts-expect-error -- `admin.extra` is not in the contract (nested groups are checked too)
      rpc(contract, implemented, { ping, admin: { count, reset, extra: count } });
      // @ts-expect-error -- `admin.reset` is missing
      rpc(contract, implemented, { ping, admin: { count } });
      // @ts-expect-error -- `reset` does not implement `count` (another output schema)
      rpc(contract, implemented, { ping, admin: { count: reset, reset } });
      // @ts-expect-error -- a bare `os` procedure is not the contract's procedure
      rpc(contract, implemented, { ping: () => bare.handler(() => 1), admin: { count, reset } });
      // @ts-expect-error -- the procedure implements another contract (its output is a string)
      rpc(contract, implemented, { ping: () => implement(other).pong.handler(() => 'x'), admin: { count, reset } });
    };
    expect(refused).toBeTypeOf('function');
  });

  it('says which key is extra in the error, so the fix is obvious', () => {
    type Guard = Parameters<
      typeof rpc<
        typeof contract,
        Os,
        { ping: typeof ping; admin: { count: typeof count; reset: typeof reset }; extra: typeof ping }
      >
    >[2];
    expectTypeOf<Guard>().toHaveProperty('DOT: a procedure key is not in the contract');
  });
});

describe('usecases and procedures in their own files', () => {
  const emit = (path: string): string =>
    ts.transpileModule(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
    }).outputText;

  it('compile with `import type { os }` / `import type { Deps }`, so the emitted modules never import the feature back', () => {
    const file = fileURLToPath(new URL('fixtures/rpc-app/digest/procedures/preview.ts', import.meta.url));
    expect(readFileSync(file, 'utf8')).toContain("import type { os } from '../feature.js'");
    const procedure = emit('fixtures/rpc-app/digest/procedures/preview.ts');
    // The `authed` import stays (a value); the type-only import of the feature is gone.
    expect(procedure).toContain("from '../../orpc.js'");
    expect(procedure).not.toContain('feature.js');
    expect(emit('fixtures/rpc-app/digest/usecases/preview.ts')).not.toContain('feature.js');
  });
});
