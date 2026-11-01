/**
 * Native sign-in with an id token: only a token the provider really signed for this app becomes a
 * session, and that session is a bearer token `auth.principal` accepts. A forged or replayed token
 * signs no one in and leaves no user or session behind. The engine's own Google verifier runs; only
 * Google's key endpoint is answered locally, with a key this test made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthDefinition } from '../definition.js';
import { failingStore, sharedStore } from '../__fixtures__/rate-limit-store.js';
import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { AUTH_ERROR_CODES } from '../errors.js';
import { testAuth } from '../testing/index.js';
import { CLIENT_KEY_HEADER } from './security/client-key.js';

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
/** The audience Google writes into tokens for this app: the test client id `testAuth` gives Google. */
const GOOGLE_CLIENT_ID = 'google-test-id';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['google', 'github'],
  sessions: { bearer: true },
});

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const encodeJson = (value: object): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

type SigningKey = { readonly kid: string; readonly privateKey: CryptoKey; readonly jwk: JsonWebKey };

async function signingKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  return { kid, privateKey: pair.privateKey, jwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}

/** An RS256 id token, as Google's SDK hands it to a native app. */
async function googleIdToken(key: SigningKey, claims: Readonly<Record<string, unknown>>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: 'RS256', kid: key.kid, typ: 'JWT' });
  const payload = encodeJson({
    iss: 'https://accounts.google.com',
    aud: GOOGLE_CLIENT_ID,
    sub: '1234567890',
    email: 'ada@notes.test',
    email_verified: true,
    name: 'Ada',
    iat: now,
    exp: now + 600,
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

let google: SigningKey;
/** How often the verifier fetched Google's keys: once per token it checked. */
let certFetches = 0;

beforeEach(async () => {
  google = await signingKey('google-key');
  certFetches = 0;
  const realFetch = globalThis.fetch;
  // Only Google's published keys are answered here; the verifier itself is the engine's.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === GOOGLE_CERTS) {
      certFetches += 1;
      return Promise.resolve(Response.json({ keys: [{ ...google.jwk, kid: google.kid, alg: 'RS256', use: 'sig' }] }));
    }
    return realFetch(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth.signInWithIdToken', () => {
  it('turns a token Google signed for this app into a bearer session that auth.principal resolves', async () => {
    const userCreated = vi.fn();
    const signIn = vi.fn();
    const { auth, dispose } = await testAuth(definition, { tables: authTables, on: { userCreated, signIn } });
    try {
      const idToken = await googleIdToken(google, {});
      const session = await auth.signInWithIdToken({ provider: 'google', idToken, headers: new Headers() });
      if (session === null) throw new Error('expected the token to be accepted');
      expect(session.principal.user.email).toBe('ada@notes.test');
      expect(session.principal.via).toBe('bearer');

      const again = await auth.principal(new Headers({ authorization: `Bearer ${session.token}` }));
      expect(again?.user.id).toBe(session.principal.user.id);
      // The app's `userCreated` and `signIn` observers see native sign-ins like any other.
      expect(userCreated).toHaveBeenCalledWith(expect.objectContaining({ method: 'google' }));
      expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ method: 'google' }));
    } finally {
      await dispose();
    }
  });

  it('refuses a forged token: null, no user, no session', async () => {
    const signInFailed = vi.fn();
    const { auth, db, dispose } = await testAuth(definition, { tables: authTables, on: { signInFailed } });
    try {
      const forger = await signingKey(google.kid);
      const idToken = await googleIdToken(forger, {});
      expect(await auth.signInWithIdToken({ provider: 'google', idToken, headers: new Headers() })).toBeNull();
      expect(await db.select().from(authTables.User)).toHaveLength(0);
      expect(await db.select().from(authTables.Session)).toHaveLength(0);
      expect(signInFailed).toHaveBeenCalledWith(expect.objectContaining({ method: 'google', reason: 'credentials' }));
    } finally {
      await dispose();
    }
  });

  it("refuses a real token minted for another app or another sign-in's nonce", async () => {
    const { auth, db, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const otherApp = await googleIdToken(google, { aud: 'someone-elses-client-id' });
      expect(
        await auth.signInWithIdToken({ provider: 'google', idToken: otherApp, headers: new Headers() }),
      ).toBeNull();
      // A token captured from another sign-in carries that sign-in's nonce, not this one's.
      const replayed = await googleIdToken(google, { nonce: 'nonce-of-another-sign-in' });
      expect(
        await auth.signInWithIdToken({ provider: 'google', idToken: replayed, nonce: 'n-1', headers: new Headers() }),
      ).toBeNull();
      expect(await db.select().from(authTables.Session)).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it('answers supportsIdToken only for enabled methods whose id tokens the engine verifies', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      expect(auth.supportsIdToken('google')).toBe(true);
      // Enabled, but GitHub issues no id tokens.
      expect(auth.supportsIdToken('github')).toBe(false);
      // Verifiable, but not enabled by this definition.
      expect(auth.supportsIdToken('apple')).toBe(false);
    } finally {
      await dispose();
    }
  });

  it('refuses at run time a provider the types would refuse, and needs bearer sessions', async () => {
    const cookiesOnly = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['google'] });
    const { auth, dispose } = await testAuth(cookiesOnly, { tables: authTables });
    try {
      const idToken = await googleIdToken(google, {});
      await expect(
        auth.signInWithIdToken({ provider: 'google', idToken, headers: new Headers() }),
      ).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidConfig });
      // A definition typed loosely (`AuthDefinition`) lets any id-token method through the types.
      const loose: AuthDefinition = defineAuth({ ...definition, methods: ['google'] });
      const { auth: looseAuth, dispose: disposeLoose } = await testAuth(loose, { tables: authTables });
      try {
        await expect(
          looseAuth.signInWithIdToken({ provider: 'apple', idToken, headers: new Headers() }),
        ).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidConfig });
      } finally {
        await disposeLoose();
      }
    } finally {
      await dispose();
    }
  });
});

describe('auth.signInWithIdToken rate limit', () => {
  const limited = { clientIp: { header: 'cf-connecting-ip' } };
  const from = (ip: string, extra: HeadersInit = {}) => new Headers({ 'cf-connecting-ip': ip, ...extra });

  it('refuses the 4th sign-in from one address in the window with E429, before the verifier runs', async () => {
    const signInFailed = vi.fn();
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: limited,
      on: { signInFailed },
    });
    try {
      const idToken = await googleIdToken(google, {});
      for (let attempt = 0; attempt < 3; attempt++) {
        await auth.signInWithIdToken({ provider: 'google', idToken, headers: from('203.0.113.7') });
      }
      expect(certFetches).toBe(3);
      const refused = auth.signInWithIdToken({ provider: 'google', idToken, headers: from('203.0.113.7') });
      await expect(refused).rejects.toMatchObject({
        code: AUTH_ERROR_CODES.rateLimited,
        retryAfter: expect.any(Number),
      });
      // Brute force never reaches the token check.
      expect(certFetches).toBe(3);
      expect(signInFailed).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rateLimited' }));
    } finally {
      await dispose();
    }
  });

  it('keys on the trusted client address only: another client passes, a spoofed x-forwarded-for does not', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: limited,
    });
    try {
      const idToken = await googleIdToken(google, {});
      for (let attempt = 0; attempt < 3; attempt++) {
        const headers = from('203.0.113.7', { 'x-forwarded-for': `198.51.100.${attempt}` });
        await auth.signInWithIdToken({ provider: 'google', idToken, headers });
      }
      const spoofed = from('203.0.113.7', { 'x-forwarded-for': '198.51.100.99' });
      await expect(auth.signInWithIdToken({ provider: 'google', idToken, headers: spoofed })).rejects.toMatchObject({
        code: AUTH_ERROR_CODES.rateLimited,
      });
      const otherClient = await auth.signInWithIdToken({ provider: 'google', idToken, headers: from('203.0.113.8') });
      expect(otherClient).not.toBeNull();
    } finally {
      await dispose();
    }
  });

  it('without clientIp.header, no forged header picks a new bucket', async () => {
    // WHY: an id-token call carries headers only, no socket. Without a configured header every
    // caller shares one budget; a header the caller writes must not buy a fresh one.
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: { store: sharedStore() } });
    try {
      const idToken = await googleIdToken(google, {});
      for (let attempt = 0; attempt < 3; attempt++) {
        const headers = new Headers({ 'x-forwarded-for': `198.51.100.${attempt}` });
        await auth.signInWithIdToken({ provider: 'google', idToken, headers });
      }
      const forged = new Headers({ [CLIENT_KEY_HEADER]: '198.51.100.99', 'x-forwarded-for': '198.51.100.99' });
      await expect(auth.signInWithIdToken({ provider: 'google', idToken, headers: forged })).rejects.toMatchObject({
        code: AUTH_ERROR_CODES.rateLimited,
      });
    } finally {
      await dispose();
    }
  });

  it('counts on a clientAddress the caller passes: one address is refused, another passes', async () => {
    // WHY: a native sign-in carries headers only. The server knows the socket; passing it keeps one
    // client's failures from using up the budget of every other client.
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: { store: sharedStore() } });
    try {
      const idToken = await googleIdToken(google, {});
      const from = (clientAddress: string) =>
        auth.signInWithIdToken({ provider: 'google', idToken, headers: new Headers(), clientAddress });
      for (let attempt = 0; attempt < 3; attempt++) await from('203.0.113.7');
      await expect(from('203.0.113.7')).rejects.toMatchObject({ code: AUTH_ERROR_CODES.rateLimited });
      await expect(from('203.0.113.8')).resolves.not.toBeNull();
    } finally {
      await dispose();
    }
  });

  it("with clientIp: { from: 'socket' } in production, refuses a sign-in without clientAddress (E010)", async () => {
    // WHY: an id-token call has no socket. In production that would mean one shared budget, so
    // the caller must pass the address it knows.
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { production: true, clientIp: { from: 'socket' } },
    });
    try {
      const idToken = await googleIdToken(google, {});
      await expect(auth.signInWithIdToken({ provider: 'google', idToken, headers: new Headers() })).rejects.toMatchObject({
        code: AUTH_ERROR_CODES.socketAddressMissing,
      });
      await expect(
        auth.signInWithIdToken({ provider: 'google', idToken, headers: new Headers(), clientAddress: '203.0.113.7' }),
      ).resolves.not.toBeNull();
    } finally {
      await dispose();
    }
  });

  it('fails closed with E503 when the store fails, never a pass', async () => {
    const { auth, db, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: failingStore() },
      runtime: limited,
    });
    try {
      const idToken = await googleIdToken(google, {});
      await expect(
        auth.signInWithIdToken({ provider: 'google', idToken, headers: from('203.0.113.7') }),
      ).rejects.toMatchObject({ code: AUTH_ERROR_CODES.storeUnavailable });
      expect(await db.select().from(authTables.Session)).toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});
