/**
 * Tiny stand-ins for an app's gateway and auth plugins, shared by the
 * tanstackStart / startServer / mounts tests. Each call builds fresh plugins
 * with their own call counters, so tests never share state.
 */
import { infra } from '@arki/dot';

export type Principal = { readonly user: { readonly id: string } };

/** The principal named by the `x-user` header, or null. */
function principalOf(headers: Headers): Principal | null {
  const id = headers.get('x-user');
  return id === null ? null : { user: { id } };
}

export function makeAuthn() {
  const calls = { principal: 0, handler: 0 };
  const authn = infra({
    name: 'authn',
    provides: {
      auth: () => ({
        principal: async (headers: Headers): Promise<Principal | null> => {
          calls.principal += 1;
          return principalOf(headers);
        },
        handler: async (request: Request) => {
          calls.handler += 1;
          return Response.json({ auth: new URL(request.url).pathname });
        },
      }),
    },
  });
  return { authn, calls };
}

/**
 * Published as `api`, not `rpc`: the mounts must work from the plugin's own
 * needs, whatever key the app's gateway uses. `handle` answers
 * `<prefix>/ping`, misses everything else, and throws on `<prefix>/boom`.
 */
export function makeGateway() {
  const gateway = infra({
    name: 'gateway',
    provides: {
      api: () => ({
        client: async (headers: Headers) => ({ caller: headers.get('x-user') }),
        handle: async (request: Request, prefix: `/${string}`) => {
          const { pathname } = new URL(request.url);
          if (pathname === `${prefix}/boom`) throw new Error('database password leaked');
          if (pathname !== `${prefix}/ping`) return { matched: false, response: undefined };
          return { matched: true, response: Response.json({ pong: true }) };
        },
      }),
    },
  });
  return { gateway };
}
