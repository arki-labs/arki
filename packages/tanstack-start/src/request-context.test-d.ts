/**
 * The request context is written once — by the app's `tanstackStart()`
 * options — and inferred everywhere else. These checks fail the moment a
 * key is renamed, `session` stops following `options.session`, or a wiring
 * mistake (missing provider, undeclared mount) starts to compile.
 */
import { describe, expectTypeOf, test } from 'vitest';

import { defineApp, infra } from '@arki/dot';

import type { RequestContextOf } from './request-context';
import { tanstackStart } from './dot';
import { authHandlers, cronHandlers, healthHandlers, rpcHandlers } from './mounts';
import { startServer } from './start-server';

type Principal = { readonly user: { readonly id: string } };
type Client = { readonly posts: { list(): Promise<readonly string[]> } };

/** The gateway is published as `api`: nothing in the package assumes a service key. */
const gateway = infra({
  name: 'gateway',
  provides: {
    api: () => ({
      client: (_headers: Headers): Promise<Client> => Promise.resolve({ posts: { list: () => Promise.resolve([]) } }),
      handle: (_request: Request, _prefix: `/${string}`) =>
        Promise.resolve({ matched: false as const, response: undefined }),
    }),
  },
});

const authn = infra({
  name: 'authn',
  provides: {
    auth: () => ({
      principal: (_headers: Headers): Promise<Principal | null> => Promise.resolve(null),
      handler: (_request: Request) => Promise.resolve(new Response(null)),
    }),
  },
});

const start = tanstackStart({
  needs: { api: gateway.provides.api, auth: authn.provides.auth },
  session: ({ auth }, request) => auth.principal(request.headers),
  rpc: ({ api }, request) => api.client(request.headers),
  mounts: {
    rpc: { at: '/api/orpc', serve: ({ api }, request, prefix) => api.handle(request, prefix) },
    auth: { at: '/api/auth', serve: ({ auth }, request) => auth.handler(request) },
  },
});

const app = defineApp('shop').infra(authn).infra(gateway).entrypoints(start);

type Context = RequestContextOf<typeof app>;

const noMounts = tanstackStart({ needs: { api: gateway.provides.api }, session: () => null, rpc: () => 1 });
const _bareApp = defineApp('bare').infra(gateway).entrypoints(noMounts);

declare const appContext: Context;
declare const bareContext: RequestContextOf<typeof _bareApp>;
declare const request: Request;

describe('RequestContextOf', () => {
  test('has exactly the five fixed keys', () => {
    expectTypeOf<keyof Context>().toEqualTypeOf<'services' | 'rpc' | 'session' | 'requestId' | 'signal'>();
  });

  test('session returns what options.session returns, rpc what options.rpc resolves to', () => {
    expectTypeOf<Context['session']>().toEqualTypeOf<() => Promise<Principal | null>>();
    expectTypeOf<Context['rpc']>().toEqualTypeOf<Client>();
    expectTypeOf<Context['requestId']>().toEqualTypeOf<string>();
    expectTypeOf<Context['signal']>().toEqualTypeOf<AbortSignal>();
  });

  test('services are the app services, tanstackStart included', () => {
    expectTypeOf<keyof Context['services']>().toEqualTypeOf<'auth' | 'api' | 'tanstackStart'>();
  });
});

describe('wiring mistakes do not compile', () => {
  test('tanstackStart() before the plugins that provide its needs', () => {
    // @ts-expect-error -- the gateway (api) is not mounted before the entrypoint
    defineApp('shop').infra(authn).entrypoints(start);
    // @ts-expect-error -- nothing provides api or auth
    defineApp('shop').entrypoints(start);
  });

  test('a mount reading a need the plugin does not declare', () => {
    tanstackStart({
      needs: { api: gateway.provides.api },
      session: () => null,
      rpc: () => null,
      // @ts-expect-error -- `auth` is not among the plugin's needs
      mounts: { auth: { at: '/api/auth', serve: ({ auth }, request) => auth.handler(request) } },
    });
  });

  test('a handler for a mount the app did not declare', () => {
    // @ts-expect-error -- no rpc mount declared
    void rpcHandlers().POST({ request, context: bareContext });
    // @ts-expect-error -- no auth mount declared
    void authHandlers().POST({ request, context: bareContext });
    // @ts-expect-error -- no cron mount declared
    void cronHandlers().POST({ request, context: bareContext });
    // @ts-expect-error -- no health mount declared
    void healthHandlers().GET({ context: bareContext });
    // `app` declares rpc and auth, but not cron.
    // @ts-expect-error -- no cron mount declared
    void cronHandlers().POST({ request, context: appContext });
  });
});

describe('startServer', () => {
  test('hands the handler the context RequestContextOf names', () => {
    startServer(app, {
      handler: (_request, { context }) => {
        expectTypeOf(context).toEqualTypeOf<Context>();
        return new Response(null);
      },
    });
  });

  test('accepts a handler typed from the Register augmentation, as Start is', () => {
    const fromRegister = (_request: Request, _options: { context: Context & { nonce?: string } }) =>
      new Response(null);
    startServer(app, { handler: fromRegister });
  });

  test('handlers for declared mounts accept the app context as Start passes it', () => {
    void rpcHandlers().POST({ request, context: appContext });
    void rpcHandlers().OPTIONS({ request, context: appContext });
    void authHandlers().GET({ request, context: appContext });
  });
});
