/**
 * `signInWithIdToken` takes only the definition's enabled methods whose id tokens the engine can
 * verify. A disabled provider, or one without id tokens, does not compile; `supportsIdToken`
 * narrows a method name so app code can branch without naming a disabled provider.
 */
import { describe, expectTypeOf, it } from 'vitest';

import type { sessionTables } from '../__fixtures__/session-tables.js';
import type { AuthDefinition, SocialMethod } from '../definition.js';
import type { Auth } from './build.js';
import type { IdTokenSession, PrincipalFor } from './types.js';

type GamesDefinition = AuthDefinition<readonly ['password', 'google', 'github']>;
type PasswordOnly = AuthDefinition<readonly ['password']>;
type Tables = typeof sessionTables;

declare const auth: Auth<GamesDefinition, Tables>;
declare const passwordAuth: Auth<PasswordOnly, Tables>;
declare const method: SocialMethod;
const headers = new Headers();

describe('signInWithIdToken', () => {
  it('takes an enabled id-token method and returns the bearer token with the principal', () => {
    expectTypeOf(auth.signInWithIdToken({ provider: 'google', idToken: 't', headers })).toEqualTypeOf<
      Promise<IdTokenSession<PrincipalFor<GamesDefinition, Tables>> | null>
    >();
  });

  it('refuses a disabled provider and one without id tokens', () => {
    // @ts-expect-error `apple` is not enabled by this definition
    void auth.signInWithIdToken({ provider: 'apple', idToken: 't', headers });
    // @ts-expect-error GitHub is enabled but issues no id tokens
    void auth.signInWithIdToken({ provider: 'github', idToken: 't', headers });
    // @ts-expect-error a definition without social methods has no id-token provider at all
    void passwordAuth.signInWithIdToken({ provider: 'google', idToken: 't', headers });
  });

  it('narrows through supportsIdToken', () => {
    if (auth.supportsIdToken(method)) expectTypeOf(method).toEqualTypeOf<'google'>();
    if (passwordAuth.supportsIdToken(method)) expectTypeOf(method).toBeNever();
  });
});
