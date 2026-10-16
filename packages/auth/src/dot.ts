/**
 * `@arki/auth` in a Dot app. Node and Bun.
 *
 * `auth(definition, bindings)` provides `auth`: the same factory as `createAuth`, with `db` and
 * `mail` taken from the graph (the `db` adapter and `@arki/mail/dot`). `runtime` runs at boot,
 * so `dot explain` and the manifest never read secrets.
 *
 * @example
 * export const authn = auth(authDefinition, { tables: authTables, rateLimit: { store: kv }, runtime: () => ({ … }) });
 * export type Auth = AuthOf<typeof authn>;
 * defineApp('notes').use(database).use(mail(() => ({ … }))).use(authn);
 */
import type { Plugin } from '@arki/dot/plugin';
import type { Mailer } from '@arki/mail';
import { plugin, service } from '@arki/dot/plugin';

import type { AuthDefinition } from './definition.js';
import type { Auth } from './pg/index.js';
import type { AuthBindings, AuthDb, AuthTables } from './pg/types.js';
import { createAuth } from './pg/index.js';

const AUTH_PLUGIN_VERSION = '0.2.0';

/** The auth as a Dot service named `auth`. Needs `db` and `mail`. */
export function auth<D extends AuthDefinition, T extends AuthTables>(
  definition: D,
  bindings: Omit<AuthBindings<D, T>, 'db' | 'mail'>,
) {
  return plugin({
    name: 'auth',
    version: AUTH_PLUGIN_VERSION,
    needs: { db: service<AuthDb>(), mail: service<Mailer>() },
    configure(ctx) {
      ctx.registerService('auth', 'auth');
      ctx.declareProvides('auth');
    },
    provides: {
      auth: ({ db, mail }): Auth<D, T> => createAuth(definition, { ...bindings, db, mail }),
    },
  });
}

/** The `auth` service type of an `auth(...)` plugin: `AuthOf<typeof authn>`. */
export type AuthOf<P> = P extends Plugin<infer _Needs, { readonly auth: infer A }> ? A : never;
