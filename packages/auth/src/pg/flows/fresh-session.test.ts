/**
 * The grown-up check: `sessions.freshFor` and the `freshSession` step. A session older than the
 * window is refused, a fresh sign-in on the same request replaces the old session, and the engine's
 * own delete-account route follows the same window. The clock is the only stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cookiesOf, get, PASSWORD, post } from '../../__fixtures__/http.js';
import { authTables as sqliteAuthTables } from '../../__fixtures__/sqlite-tables.js';
import { authTables } from '../../__fixtures__/tables.js';
import { defineAuth } from '../../definition.js';
import { freshSession } from '../../steps.js';
import { lastMagicLink, testAuth } from '../../testing/index.js';

const HALF_HOUR = 1800;
const base = {
  app: { name: 'Notes', key: 'notes' },
  methods: ['password', 'magicLink'],
  verifyEmail: 'none',
  account: { delete: true },
} as const;
const definition = defineAuth({ ...base, sessions: { freshFor: HALF_HOUR } });
const noWindow = defineAuth(base);

type Handler = Parameters<typeof post>[0];
const signUp = (auth: Handler, email: string) => post(auth, '/sign-up/email', { email, password: PASSWORD, name: 'A' });
const signIn = (auth: Handler, email: string, cookie?: string) =>
  post(auth, '/sign-in/email', { email, password: PASSWORD }, cookie === undefined ? undefined : { cookie });
const headersOf = (cookie: string) => new Headers({ cookie });

let start = 0;
const later = (seconds: number) => vi.setSystemTime(start + seconds * 1000);

beforeEach(() => {
  // Only `Date` moves: the database driver keeps its real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  start = Date.now();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('freshSession', () => {
  it('passes a session younger than freshFor and refuses an older one with freshFor in the data', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const cookie = cookiesOf(await signUp(auth, 'ada@notes.test'));
      later(HALF_HOUR - 1);
      const fresh = freshSession({ principal: await auth.principal(headersOf(cookie)) });
      expect(fresh).toHaveProperty('principal.user.email', 'ada@notes.test');

      later(HALF_HOUR);
      const stale = freshSession({ principal: await auth.principal(headersOf(cookie)) });
      expect(stale).toMatchObject({ code: 'auth.session_not_fresh', status: 403, data: { freshFor: HALF_HOUR } });
    } finally {
      await dispose();
    }
  });

  it('gives a guest the same failure as authed', () => {
    expect(freshSession({ principal: null })).toMatchObject({ code: 'auth.unauthenticated', status: 401 });
  });

  it('throws ARKI_AUTH_E001 when the auth sets no freshFor', async () => {
    const { auth, dispose } = await testAuth(noWindow, { tables: authTables });
    try {
      const cookie = cookiesOf(await signUp(auth, 'ada@notes.test'));
      const principal = await auth.principal(headersOf(cookie));
      expect(() => freshSession({ principal })).toThrow(expect.objectContaining({ code: 'ARKI_AUTH_E001' }));
    } finally {
      await dispose();
    }
  });

  it('refuses a freshFor that is not a positive whole number or outlives the session', () => {
    expect(() => defineAuth({ ...base, sessions: { freshFor: 0 } })).toThrow(/sessions\.freshFor/);
    expect(() => defineAuth({ ...base, sessions: { expiresIn: 600, refreshEvery: 60, freshFor: 601 } })).toThrow(
      /cannot be longer/,
    );
  });
});

describe('a re-sign-in replaces the session', () => {
  it('password: the old cookie dies, the new session is fresh, one session is left', async () => {
    const { auth, db, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const old = cookiesOf(await signUp(auth, 'ada@notes.test'));
      later(HALF_HOUR + 60);
      const again = await signIn(auth, 'ada@notes.test', old);
      expect(again.status).toBe(200);

      expect(await auth.principal(headersOf(old))).toBeNull();
      const principal = await auth.principal(headersOf(cookiesOf(again)));
      expect(freshSession({ principal })).toHaveProperty('principal.user.email', 'ada@notes.test');
      expect(await db.select().from(authTables.Session)).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it('magic link: the verify request with the old cookie replaces that session', async () => {
    const { auth, db, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      // The first link makes a verified user. An unverified one would lose every session to the
      // engine's own rule when a link proves the address, which would hide this check.
      await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
      const old = cookiesOf(await get(auth, lastMagicLink(mail, 'ada@notes.test')));
      later(HALF_HOUR + 60);
      await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
      const verified = await get(auth, lastMagicLink(mail, 'ada@notes.test'), { cookie: old });
      expect(verified.status).toBeLessThan(400);

      expect(await auth.principal(headersOf(old))).toBeNull();
      const principal = await auth.principal(headersOf(cookiesOf(verified)));
      expect(freshSession({ principal })).toHaveProperty('principal.user.email', 'ada@notes.test');
      expect(await db.select().from(authTables.Session)).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it("another user's sign-in on the same request keeps the first user's session", async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const ada = cookiesOf(await signUp(auth, 'ada@notes.test'));
      await signUp(auth, 'bob@notes.test');
      await expect(signIn(auth, 'bob@notes.test', ada)).resolves.toHaveProperty('status', 200);
      expect(await auth.principal(headersOf(ada))).toHaveProperty('user.email', 'ada@notes.test');
    } finally {
      await dispose();
    }
  });

  it('works the same on SQLite (libSQL)', async () => {
    const { auth, db, dispose } = await testAuth(definition, { tables: sqliteAuthTables, database: 'libsql' });
    try {
      const old = cookiesOf(await signUp(auth, 'ada@notes.test'));
      later(HALF_HOUR + 60);
      const again = await signIn(auth, 'ada@notes.test', old);
      expect(await auth.principal(headersOf(old))).toBeNull();
      const principal = await auth.principal(headersOf(cookiesOf(again)));
      expect(freshSession({ principal })).toHaveProperty('principal.user.email', 'ada@notes.test');
      expect(await db.select().from(sqliteAuthTables.Session)).toHaveLength(1);
    } finally {
      await dispose();
    }
  });
});

describe("the engine's delete-account route follows freshFor", () => {
  it('refuses a stale session and accepts the fresh one from a re-sign-in', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const old = cookiesOf(await signUp(auth, 'ada@notes.test'));
      later(HALF_HOUR + 60);
      const refused = await post(auth, '/delete-user', {}, { cookie: old });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toHaveProperty('code', 'SESSION_EXPIRED');

      const again = cookiesOf(await signIn(auth, 'ada@notes.test', old));
      await expect(post(auth, '/delete-user', {}, { cookie: again })).resolves.toHaveProperty('status', 200);
    } finally {
      await dispose();
    }
  });

  it('without freshFor keeps the engine default: a half-hour-old session may still delete', async () => {
    const { auth, dispose } = await testAuth(noWindow, { tables: authTables });
    try {
      const cookie = cookiesOf(await signUp(auth, 'ada@notes.test'));
      later(HALF_HOUR + 60);
      await expect(post(auth, '/delete-user', {}, { cookie })).resolves.toHaveProperty('status', 200);
    } finally {
      await dispose();
    }
  });
});
