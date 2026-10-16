/**
 * Literal methods drive the runtime bindings: an enabled social method must get credentials, a
 * disabled one cannot. A typo in a method name does not compile.
 */
import { describe, expectTypeOf, it } from 'vitest';

import type { AuthRuntime } from './pg/types.js';
import { defineAuth } from './definition.js';

const withGoogle = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password', 'google'] });
const passwordOnly = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });
const base = { url: 'http://localhost:3000', secret: undefined, production: false } as const;
const credentials = { clientId: 'id', clientSecret: 'secret' };

describe('defineAuth', () => {
  it('keeps the methods as a literal tuple', () => {
    expectTypeOf(withGoogle.methods).toEqualTypeOf<readonly ['password', 'google']>();
  });

  it('keeps the exposed field names as a literal tuple', () => {
    const definition = defineAuth({
      app: { name: 'Notes', key: 'notes' },
      methods: ['magicLink'],
      user: { fields: ['plan', 'segment'], signUpFields: ['plan'] },
    });
    expectTypeOf(definition.user?.fields).toEqualTypeOf<readonly ['plan', 'segment'] | undefined>();
  });

  it('refuses an unknown method', () => {
    // @ts-expect-error -- 'twitter' is not a method
    defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['twitter'] });
  });

  it('refuses a sign-up field that is not exposed', () => {
    defineAuth({
      app: { name: 'Notes', key: 'notes' },
      methods: ['password'],
      // @ts-expect-error -- 'role' is not in `fields`
      user: { fields: ['plan'], signUpFields: ['role'] },
    });
  });
});

describe('runtime.providers', () => {
  it('requires the credentials of every enabled social method', () => {
    const ok: AuthRuntime<typeof withGoogle> = { ...base, providers: { google: credentials } };
    expectTypeOf(ok.providers.google).toHaveProperty('clientSecret');
    // @ts-expect-error -- google is enabled, so its credentials are required
    const missing: AuthRuntime<typeof withGoogle> = { ...base, providers: {} };
    // @ts-expect-error -- providers itself is required
    const absent: AuthRuntime<typeof withGoogle> = { ...base };
    expectTypeOf(missing).not.toBeNever();
    expectTypeOf(absent).not.toBeNever();
  });

  it('rejects credentials for a method that is not enabled', () => {
    const extra: AuthRuntime<typeof withGoogle> = {
      ...base,
      // @ts-expect-error -- github is not enabled
      providers: { google: credentials, github: credentials },
    };
    expectTypeOf(extra).not.toBeNever();
  });

  it('needs no providers without social methods', () => {
    expectTypeOf(passwordOnly.methods).toEqualTypeOf<readonly ['password']>();
    const ok: AuthRuntime<typeof passwordOnly> = { ...base };
    expectTypeOf(ok).not.toBeNever();
  });

  it('reads them from a boot-time function, as the bindings do', () => {
    const runtime: () => AuthRuntime<typeof withGoogle> = () => ({
      ...base,
      // @ts-expect-error -- github is not enabled, also inside a returned literal
      providers: { google: credentials, github: credentials },
    });
    expectTypeOf(runtime).returns.toHaveProperty('providers');
  });
});
