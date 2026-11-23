/**
 * Passkey sign-in on real PGlite and libSQL, with a software authenticator (a real ES256 key and
 * real CBOR, not a stand-in for the engine): a signed-in user adds a passkey, lists and deletes
 * their own, and signs in with it later. A passkey sign-in is a fresh sign-in, and a passkey
 * sign-in on a stale session replaces it. The clock is the only stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createSoftwareAuthenticator } from '../../__fixtures__/authenticator.js';
import { cookiesOf, get, ORIGIN, PASSWORD, post } from '../../__fixtures__/http.js';
import {
  authTables as sqliteAuthTables,
  passkeyTables as sqlitePasskeyTables,
} from '../../__fixtures__/sqlite-tables.js';
import { authTables, passkeyTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { freshSession } from '../../steps.js';
import { testAuth } from '../../testing/index.js';

const HALF_HOUR = 1800;
const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password', 'passkey'],
  passkey: { rpName: 'Notes' },
  verifyEmail: 'none',
  sessions: { freshFor: HALF_HOUR },
});
const tables = { ...authTables, ...passkeyTables };

type Handler = Parameters<typeof post>[0];
type Authenticator = Awaited<ReturnType<typeof createSoftwareAuthenticator>>;
const headersOf = (cookie: string) => new Headers({ cookie });
const both = (...cookies: readonly string[]) => cookies.filter(cookie => cookie !== '').join('; ');
const signUp = async (auth: Handler, email: string) =>
  cookiesOf(await post(auth, '/sign-up/email', { email, password: PASSWORD, name: 'A' }));

const listed = z.array(z.object({ id: z.string(), name: z.string().nullish(), credentialID: z.string() }));

async function passkeysOf(auth: Handler, cookie: string) {
  const response = await get(auth, '/passkey/list-user-passkeys', { cookie });
  return listed.parse(await response.json());
}

/** Registration as the browser runs it: options, the device's answer, verification. */
async function addPasskey(auth: Handler, session: string, device: Authenticator) {
  const options = await get(auth, '/passkey/generate-register-options', { cookie: session });
  expect(options.status).toBe(200);
  const response = await device.register(await options.json());
  return post(
    auth,
    '/passkey/verify-registration',
    { response, name: 'Phone' },
    { cookie: both(session, cookiesOf(options)) },
  );
}

/** Sign-in as the browser runs it; `session` is the cookie already on the request, if any. */
async function signInWithPasskey(auth: Handler, device: Authenticator, session = '') {
  const options = await get(auth, '/passkey/generate-authenticate-options', session === '' ? {} : { cookie: session });
  expect(options.status).toBe(200);
  const response = await device.authenticate(await options.json());
  return post(auth, '/passkey/verify-authentication', { response }, { cookie: both(session, cookiesOf(options)) });
}

let start = 0;
const later = (seconds: number) => vi.setSystemTime(start + seconds * 1000);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  start = Date.now();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the passkey definition', () => {
  it('needs rpName with the method and the method with the options', () => {
    // A list built at run time skips the type rule; the runtime check still refuses it.
    const methods: readonly 'passkey'[] = ['passkey'];
    expect(() => defineAuth({ app: { name: 'Notes', key: 'notes' }, methods })).toThrow(/passkey: \{ rpName \}/);
    expect(() =>
      defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'], passkey: { rpName: 'Notes' } }),
    ).toThrow(/method is not enabled/);
  });

  it('refuses to boot without the passkey table (E007)', async () => {
    await expect(testAuth(definition, { tables: authTables })).rejects.toMatchObject({ code: 'ARKI_AUTH_E007' });
  });
});

describe('passkey registration and management', () => {
  it('registration options need a session; sign-in options work signed out', async () => {
    const { auth, dispose } = await testAuth(definition, { tables });
    try {
      await expect(get(auth, '/passkey/generate-register-options')).resolves.toHaveProperty('status', 401);
      const session = await signUp(auth, 'ada@notes.test');
      const options = await get(auth, '/passkey/generate-register-options', { cookie: session });
      expect(await options.json()).toMatchObject({ rp: { id: 'localhost', name: 'Notes' } });

      const signedOut = await get(auth, '/passkey/generate-authenticate-options');
      expect(signedOut.status).toBe(200);
      expect(await signedOut.json()).toMatchObject({ rpId: 'localhost', challenge: expect.any(String) });
    } finally {
      await dispose();
    }
  });

  it('lists and deletes only the caller’s own passkeys', async () => {
    const { auth, db, dispose } = await testAuth(definition, { tables });
    try {
      const ada = await signUp(auth, 'ada@notes.test');
      const bob = await signUp(auth, 'bob@notes.test');
      const device = await createSoftwareAuthenticator(ORIGIN);
      await expect(addPasskey(auth, ada, device)).resolves.toHaveProperty('status', 200);

      const adas = await passkeysOf(auth, ada);
      expect(adas).toMatchObject([{ name: 'Phone', credentialID: device.id }]);
      const bobs = await passkeysOf(auth, bob);
      expect(bobs).toEqual([]);

      const [passkey] = adas;
      const refused = await post(auth, '/passkey/delete-passkey', { id: passkey?.id }, { cookie: bob });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await db.select().from(passkeyTables.Passkey)).toHaveLength(1);

      await expect(post(auth, '/passkey/delete-passkey', { id: passkey?.id }, { cookie: ada })).resolves.toHaveProperty(
        'status',
        200,
      );
      expect(await db.select().from(passkeyTables.Passkey)).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it('refuses an answer signed for another origin', async () => {
    const { auth, dispose } = await testAuth(definition, { tables });
    try {
      const ada = await signUp(auth, 'ada@notes.test');
      const elsewhere = await createSoftwareAuthenticator('http://evil.test');
      await expect(addPasskey(auth, ada, elsewhere)).resolves.toHaveProperty('status', 400);
    } finally {
      await dispose();
    }
  });
});

describe('passkey sign-in', () => {
  it('register, sign out, sign in with the passkey: the new session is fresh', async () => {
    const { auth, dispose } = await testAuth(definition, { tables });
    try {
      const device = await createSoftwareAuthenticator(ORIGIN);
      const first = await signUp(auth, 'ada@notes.test');
      await expect(addPasskey(auth, first, device)).resolves.toHaveProperty('status', 200);
      await expect(post(auth, '/sign-out', {}, { cookie: first })).resolves.toHaveProperty('status', 200);

      const signedIn = await signInWithPasskey(auth, device);
      expect(signedIn.status).toBe(200);
      const principal = await auth.principal(headersOf(cookiesOf(signedIn)));
      expect(freshSession({ principal })).toHaveProperty('principal.user.email', 'ada@notes.test');
    } finally {
      await dispose();
    }
  });

  it('a passkey sign-in on a stale session replaces it and leaves one fresh session', async () => {
    const { auth, db, dispose } = await testAuth(definition, { tables });
    try {
      const device = await createSoftwareAuthenticator(ORIGIN);
      const old = await signUp(auth, 'ada@notes.test');
      await expect(addPasskey(auth, old, device)).resolves.toHaveProperty('status', 200);
      later(HALF_HOUR + 60);
      expect(freshSession({ principal: await auth.principal(headersOf(old)) })).toHaveProperty(
        'code',
        'auth.session_not_fresh',
      );

      const again = await signInWithPasskey(auth, device, old);
      expect(again.status).toBe(200);
      expect(await auth.principal(headersOf(old))).toBeNull();
      const principal = await auth.principal(headersOf(cookiesOf(again)));
      expect(freshSession({ principal })).toHaveProperty('principal.user.email', 'ada@notes.test');
      expect(await db.select().from(authTables.Session)).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it('works the same on SQLite (libSQL)', async () => {
    const { auth, db, dispose } = await testAuth(definition, {
      tables: { ...sqliteAuthTables, ...sqlitePasskeyTables },
      database: 'libsql',
    });
    try {
      const device = await createSoftwareAuthenticator(ORIGIN);
      const old = await signUp(auth, 'ada@notes.test');
      await expect(addPasskey(auth, old, device)).resolves.toHaveProperty('status', 200);
      later(HALF_HOUR + 60);
      const again = await signInWithPasskey(auth, device, old);
      expect(await auth.principal(headersOf(old))).toBeNull();
      const principal = await auth.principal(headersOf(cookiesOf(again)));
      expect(freshSession({ principal })).toHaveProperty('principal.user.email', 'ada@notes.test');
      expect(await db.select().from(sqliteAuthTables.Session)).toHaveLength(1);
    } finally {
      await dispose();
    }
  });
});
