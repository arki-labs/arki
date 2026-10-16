/**
 * `on.sessionCreating` writes the app's own session columns on every session the engine makes, so
 * a column like `appContext` is never missing because a sign-in path skipped it. A refusal must
 * block the session itself, not only the answer. `on.sessionCreated` sees each session once.
 */
import { describe, expect, it } from 'vitest';

import { cookiesOf, get, PASSWORD, post } from '../__fixtures__/http.js';
import { sessionTables } from '../__fixtures__/session-tables.js';
import { defineAuth } from '../definition.js';
import { AUTH_ERROR_CODES, AuthError } from '../errors.js';
import { actingAs, lastMagicLink, testAuth } from '../testing/index.js';

const definition = defineAuth({
  app: { name: 'Games', key: 'games' },
  methods: ['password', 'magicLink'],
  verifyEmail: 'none',
});

/** The app a request comes from, as a games backend reads it; server-made sessions are `server`. */
const appContextOf = (request: Request | undefined) => request?.headers.get('x-app') ?? 'server';

describe('on.sessionCreating', () => {
  it('writes the extra column for password, magic-link and actingAs sessions', async () => {
    const { auth, db, mail, dispose } = await testAuth(definition, {
      tables: sessionTables,
      on: { sessionCreating: ({ request }) => ({ appContext: appContextOf(request) }) },
    });
    try {
      const signUp = await post(
        auth,
        '/sign-up/email',
        { email: 'ada@games.test', password: PASSWORD, name: 'Ada' },
        { 'x-app': 'wordle' },
      );
      expect(signUp.status).toBe(200);
      await post(auth, '/sign-in/email', { email: 'ada@games.test', password: PASSWORD }, { 'x-app': 'sudoku' });
      await post(auth, '/sign-in/magic-link', { email: 'bob@games.test' });
      const link = await get(auth, lastMagicLink(mail, 'bob@games.test'), { 'x-app': 'chess' });
      expect(await auth.principal(new Headers({ cookie: cookiesOf(link) }))).not.toBeNull();
      await actingAs(auth, { email: 'cy@games.test' });

      const rows = await db.select().from(sessionTables.Session);
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map(row => row.appContext))).toEqual(new Set(['chess', 'server', 'sudoku', 'wordle']));
    } finally {
      await dispose();
    }
  });

  it('may return nothing: the column stays empty and the session is made', async () => {
    const { auth, db, dispose } = await testAuth(definition, {
      tables: sessionTables,
      on: { sessionCreating: () => Promise.resolve() },
    });
    try {
      const { headers } = await actingAs(auth, { email: 'ada@games.test' });
      expect(await auth.principal(headers)).not.toBeNull();
      const rows = await db.select().from(sessionTables.Session);
      expect(rows.map(row => row.appContext)).toEqual([null]);
    } finally {
      await dispose();
    }
  });

  it('refuses the session when it throws an AuthError: 403 with the code, no session row', async () => {
    const { auth, db, dispose } = await testAuth(definition, {
      tables: sessionTables,
      on: {
        sessionCreating: () => {
          throw new AuthError(AUTH_ERROR_CODES.forbidden, 'This account is suspended.');
        },
      },
    });
    try {
      const refused = await post(auth, '/sign-up/email', { email: 'ada@games.test', password: PASSWORD, name: 'Ada' });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: AUTH_ERROR_CODES.forbidden });
      expect(cookiesOf(refused)).not.toContain('session_token');
      const signIn = await post(auth, '/sign-in/email', { email: 'ada@games.test', password: PASSWORD });
      expect(signIn.status).toBe(403);
      await expect(actingAs(auth, { email: 'bob@games.test' })).rejects.toThrow('This account is suspended.');
      expect(await db.select().from(sessionTables.Session)).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

describe('on.sessionCreated', () => {
  it('fires once per session with its id and user, never the token', async () => {
    const seen: { userId: string; sessionId: string; event: object }[] = [];
    const { auth, db, dispose } = await testAuth(definition, {
      tables: sessionTables,
      on: {
        sessionCreated: event => {
          seen.push({ userId: event.userId, sessionId: event.session.id, event });
        },
      },
    });
    try {
      await post(auth, '/sign-up/email', { email: 'ada@games.test', password: PASSWORD, name: 'Ada' });
      await post(auth, '/sign-in/email', { email: 'ada@games.test', password: PASSWORD });
      const { user } = await actingAs(auth, { email: 'bob@games.test' });

      const rows = await db.select().from(sessionTables.Session);
      expect(rows).toHaveLength(3);
      expect(seen).toHaveLength(3);
      expect(new Set(seen.map(entry => entry.sessionId))).toEqual(new Set(rows.map(row => row.id)));
      expect(seen.at(-1)?.userId).toBe(user.id);
      for (const { event } of seen) expect(JSON.stringify(event)).not.toContain(rows[0]?.token ?? 'no token');
    } finally {
      await dispose();
    }
  });

  it('a throwing observer is logged and the sign-in still succeeds', async () => {
    const { auth, dispose } = await testAuth(definition, {
      tables: sessionTables,
      on: {
        sessionCreated: () => {
          throw new Error('observer bug');
        },
      },
    });
    try {
      const signUp = await post(auth, '/sign-up/email', { email: 'ada@games.test', password: PASSWORD, name: 'Ada' });
      expect(signUp.status).toBe(200);
      expect(await auth.principal(new Headers({ cookie: cookiesOf(signUp) }))).not.toBeNull();
    } finally {
      await dispose();
    }
  });
});
