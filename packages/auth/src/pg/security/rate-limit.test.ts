/**
 * Rate limits reach the wire, are shared by replicas, fail closed, and key on the trusted client
 * address only. Brute force on sign-in is the attack these tests stand in for.
 */
import { serve } from 'srvx';
import { describe, expect, it } from 'vitest';

import { fakeLog } from '@arki/log/testing';
import { is } from '@arki/schema';

import { cookiesOf, ORIGIN, PASSWORD, post } from '../../__fixtures__/http.js';
import { failingStore, sharedStore } from '../../__fixtures__/rate-limit-store.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { AUTH_ERROR_CODES } from '../../errors.js';
import { testAuth } from '../../testing/index.js';
import { CLIENT_KEY_HEADER, CLIENT_KEY_KIND_HEADER, clientIpSchema } from './client-key.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'], verifyEmail: 'none' });

const signIn = (auth: { handler: (request: Request) => Promise<Response> }, headers?: HeadersInit) =>
  post(
    auth,
    '/sign-in/email',
    { email: 'ada@notes.test', password: PASSWORD },
    headers ?? { 'cf-connecting-ip': '203.0.113.7' },
  );

/** Three sign-ins from 127.0.0.1 (forging x-forwarded-for) use up its budget; ::1 still has its own. */
async function expectSocketKeysBudget(auth: { handler: (request: Request) => Promise<Response> }): Promise<void> {
  // `::` takes IPv4 and IPv6, so 127.0.0.1 and ::1 are two real sockets of one server.
  const server = serve({ fetch: request => auth.handler(request), hostname: '::', port: 0, silent: true });
  try {
    await server.ready();
    const port = server.url === undefined ? '' : new URL(server.url).port;
    const signInFrom = (host: string, headers: HeadersInit) =>
      fetch(`http://${host}:${port}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify({ email: 'ada@notes.test', password: PASSWORD }),
      });
    for (let attempt = 0; attempt < 3; attempt++) {
      await signInFrom('127.0.0.1', { 'x-forwarded-for': `198.51.100.${attempt}` });
    }
    const sameSocket = await signInFrom('127.0.0.1', { 'x-forwarded-for': '198.51.100.99' });
    expect(sameSocket.status).toBe(429);
    const otherSocket = await signInFrom('[::1]', {});
    expect(otherSocket.status).not.toBe(429);
  } finally {
    await server.close(true);
  }
}

describe('rate limits', () => {
  it('answers the 4th sign-in in 10 s with 429 and Retry-After', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { clientIp: { header: 'cf-connecting-ip' } },
    });
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await signIn(auth);
        statuses.push(response.status);
      }
      expect(statuses).not.toContain(429);
      const refused = await signIn(auth);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it('two instances on one store share one budget', async () => {
    const store = sharedStore();
    const { auth, rebuild, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store },
      runtime: { clientIp: { header: 'cf-connecting-ip' } },
    });
    try {
      const replica = rebuild();
      await signIn(auth);
      await signIn(replica);
      await signIn(auth);
      await expect(signIn(replica)).resolves.toHaveProperty('status', 429);
    } finally {
      await dispose();
    }
  });

  it('answers 503 E503 when the store fails, never a pass', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: failingStore() },
    });
    try {
      const response = await signIn(auth);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: AUTH_ERROR_CODES.storeUnavailable });
    } finally {
      await dispose();
    }
  });

  it('`rateLimit: false` turns limiting off', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: false });
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await signIn(auth);
        statuses.push(response.status);
      }
      expect(statuses).not.toContain(429);
    } finally {
      await dispose();
    }
  });

  it('a spoofed x-forwarded-for does not pick a new bucket when clientIp.header is set', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { clientIp: { header: 'cf-connecting-ip' } },
    });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await signIn(auth, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': `198.51.100.${attempt}` });
      }
      const refused = await signIn(auth, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.99' });
      expect(refused.status).toBe(429);
      const otherClient = await signIn(auth, { 'cf-connecting-ip': '203.0.113.8' });
      expect(otherClient.status).not.toBe(429);
    } finally {
      await dispose();
    }
  });

  it('without clientIp.header, a forged x-forwarded-for or client-key header does not pick a new bucket', async () => {
    // WHY: the engine's default reads `x-forwarded-for`, which any caller writes. A fresh value per
    // request bought a fresh budget, so the sign-in limit never fired.
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: { store: sharedStore() } });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await signIn(auth, { 'x-forwarded-for': `198.51.100.${attempt}` });
      }
      const forwarded = await signIn(auth, { 'x-forwarded-for': '198.51.100.99' });
      expect(forwarded.status).toBe(429);
      const keyHeader = await signIn(auth, { [CLIENT_KEY_HEADER]: '198.51.100.98', [CLIENT_KEY_KIND_HEADER]: 'account' });
      expect(keyHeader.status).toBe(429);
    } finally {
      await dispose();
    }
  });

  it('without clientIp.header, the socket address the runtime gives keys the budget', async () => {
    // WHY: with no proxy header the socket is the only address a caller cannot forge. Keying on
    // it keeps one client's lockout from locking out every other client.
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: { store: sharedStore() } });
    try {
      await expectSocketKeysBudget(auth);
    } finally {
      await dispose();
    }
  });

  it("with clientIp: { from: 'socket' } in production, the socket address keys the budget", async () => {
    // WHY: an app with no proxy in front names the socket as its client address; production then
    // counts per socket, like a proxy header.
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { production: true, clientIp: { from: 'socket' } },
    });
    try {
      await expectSocketKeysBudget(auth);
    } finally {
      await dispose();
    }
  });

  it("with clientIp: { from: 'socket' } in production, a request with no socket address is refused (E010)", async () => {
    // WHY: without an address the request would fall back to a shared or account key. Production
    // promised a socket, so a missing one is a deployment fault to surface, never a shared budget.
    const { auth, dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { production: true, clientIp: { from: 'socket' } },
    });
    try {
      const refused = await signIn(auth, {});
      expect(refused.status).toBe(500);
      expect(await refused.json()).toMatchObject({ code: AUTH_ERROR_CODES.socketAddressMissing });
    } finally {
      await dispose();
    }
  });

  it('without clientIp.header or a socket address, two accounts do not share a bucket', async () => {
    // WHY: with one shared key, a client that fails sign-in three times locked every user out of
    // sign-in. Keyed on the target account, only the attacked account waits.
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: { store: sharedStore() } });
    const as = (email: string) => post(auth, '/sign-in/email', { email, password: 'wrong password!' });
    try {
      for (let attempt = 0; attempt < 3; attempt++) await as('ada@notes.test');
      const ada = await as('ada@notes.test');
      expect(ada.status).toBe(429);
      const adaAgain = await as('ADA@notes.test');
      expect(adaAgain.status).toBe(429);
      const bob = await as('bob@notes.test');
      expect(bob.status).not.toBe(429);
    } finally {
      await dispose();
    }
  });

  it('a session made on an account key records no client address', async () => {
    // WHY: the account key is a derived private address, not where the client is. Recording it
    // would put a made-up address into the session list and the security log.
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: { store: sharedStore() } });
    try {
      await auth.testing.signIn({ email: 'carol@notes.test' }, { password: PASSWORD });
      const signedIn = await post(auth, '/sign-in/email', { email: 'carol@notes.test', password: PASSWORD });
      expect(signedIn.status).toBe(200);
      const principal = await auth.principal(new Headers({ cookie: cookiesOf(signedIn) }));
      expect(principal?.session.ipAddress).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('in development without clientIp, boots and logs one warning naming the app', async () => {
    // WHY: development keeps the shared sign-up key so a local run needs no proxy, but the
    // developer learns at boot that production will refuse this setup.
    using logs = fakeLog();
    const { dispose } = await testAuth(definition, { tables: authTables, rateLimit: { store: sharedStore() } });
    try {
      const warnings = logs.records.filter(record => record.levelName === 'warn' && record.category === 'arki:auth');
      expect(warnings.map(record => record.message())).toEqual([expect.stringContaining('runtime().clientIp')]);
    } finally {
      await dispose();
    }
  });

  it('refuses to boot in production without clientIp when sign-up is on (E009)', async () => {
    // WHY: sign-up has no account to count on. Without a client address every visitor would share
    // one sign-up budget, so production must name the header its proxy writes.
    const booted = testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { production: true },
    });
    await expect(booted).rejects.toMatchObject({ code: AUTH_ERROR_CODES.clientAddressRequired });
    await expect(booted).rejects.toThrow('set `runtime().clientIp`');
  });

  it('ignores a body email on an endpoint whose account is not that email', async () => {
    // WHY: keying on any body email let a caller pick a fresh bucket per request on endpoints such
    // as send-verification-email. Only sign-in, the reset request and magic-link sign-in use it.
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: { store: sharedStore() } });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await post(auth, '/send-verification-email', { email: `victim-${String(attempt)}@notes.test` });
      }
      const fresh = await post(auth, '/send-verification-email', { email: 'victim-99@notes.test' });
      expect(fresh.status).toBe(429);
    } finally {
      await dispose();
    }
  });

  it('keys a signed-in request on its user, not on the email in its body', async () => {
    // WHY: the body is the caller's to choose; the session is not. A signed-in caller varying the
    // email must still spend one budget.
    const { auth, dispose } = await testAuth(definition, { tables: authTables, rateLimit: { store: sharedStore() } });
    try {
      const { headers } = await auth.testing.signIn({ email: 'eve@notes.test' });
      const reset = (email: string) =>
        post(auth, '/request-password-reset', { email }, { cookie: headers.get('cookie') ?? '' });
      for (let attempt = 0; attempt < 3; attempt++) await reset(`target-${String(attempt)}@notes.test`);
      const fresh = await reset('target-99@notes.test');
      expect(fresh.status).toBe(429);
    } finally {
      await dispose();
    }
  });

  it.each([
    ['magic link (sign-up on)', defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'] })],
    [
      'magic link (sign-up off; it still mails any address)',
      defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'], magicLink: { signUp: false } }),
    ],
  ])('refuses to boot in production without clientIp for %s (E009)', async (_name, magicLinkOnly) => {
    // WHY: a magic link mails an address the caller picks and can create the account. Without a
    // client address those requests share one budget, like sign-up.
    const booted = testAuth(magicLinkOnly, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { production: true },
    });
    await expect(booted).rejects.toMatchObject({ code: AUTH_ERROR_CODES.clientAddressRequired });
  });

  it("boots in production with clientIp: { from: 'socket' } (the E009 gate takes either form)", async () => {
    // WHY: an app with no proxy has no header to name; the socket is its client address.
    const { dispose } = await testAuth(definition, {
      tables: authTables,
      rateLimit: { store: sharedStore() },
      runtime: { production: true, clientIp: { from: 'socket' } },
    });
    await dispose();
  });

  it('checks clientIp against its schema: a header or the socket, never both', () => {
    // WHY: a value from untyped config could name both; boot must refuse it rather than guess.
    expect(is({ header: 'x-real-ip' }, clientIpSchema)).toBe(true);
    expect(is({ from: 'socket' }, clientIpSchema)).toBe(true);
    expect(is({ header: 'x-real-ip', from: 'socket' }, clientIpSchema)).toBe(false);
    expect(is({ from: 'proxy' }, clientIpSchema)).toBe(false);
  });
});
