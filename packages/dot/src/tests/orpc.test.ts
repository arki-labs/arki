/**
 * `@arki/dot/orpc` — `bind(core)` and `rpc(contract, router)`.
 *
 * Why these tests exist: a feature's handlers must get exactly what the
 * feature declared (needs, private infra, usecases) and nothing more, typed,
 * without the request context carrying it; a feature's router must implement
 * its contract, or the browser's contract client lies; and the procedures
 * file must reach the implementer without a runtime import of the feature,
 * or the module graph has a cycle that dies with a TDZ error at import.
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

describe('rpc(contract, router): the router must implement its contract', () => {
  const contract = oc.router({ ping: oc.output(z.number()) });
  const other = oc.router({ pong: oc.output(z.number()) });
  const implemented = implement(contract).$context<RequestContext>();

  it('accepts the router an implementer of that contract built, and exposes both to routerFor', () => {
    const router = { ping: implemented.ping.handler(() => 1) };
    const entry = rpc(contract, router);
    expect(entry).toMatchObject({ kind: 'rpc', key: 'rpc', contract, router });
    expect(entry.resolve({})).toBe(router);
  });

  it('rejects a bare router, a missing procedure and a router of another contract', () => {
    const refused = () => {
      // @ts-expect-error -- a bare `os` procedure is not the contract's procedure (its output schema is not the contract's)
      rpc(contract, { ping: bare.handler(() => 1) });
      // @ts-expect-error -- `ping` is missing
      rpc(contract, {});
      // @ts-expect-error -- the router implements another contract
      rpc(contract, { pong: implement(other).pong.handler(() => 1) });
    };
    expect(refused).toBeTypeOf('function');
  });
});

describe('procedures as factories over the implementer', () => {
  it('compile with `import type { os }`, so the emitted module never imports the feature back', () => {
    const file = fileURLToPath(new URL('fixtures/rpc-app/digest/procedures.ts', import.meta.url));
    const source = readFileSync(file, 'utf8');
    expect(source).toContain("import type { os } from './feature.js'");
    const emitted = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
    }).outputText;
    // The `authed` import stays (a value); the type-only import of the feature is gone.
    expect(emitted).toContain("from '../orpc.js'");
    expect(emitted).not.toContain('feature.js');
  });
});
