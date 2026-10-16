/**
 * Session management is safe: a principal sees and revokes only its own sessions, never their
 * tokens; a sign-in never reuses a presented token (no fixation); a revoked session is dead on the
 * very next request because no cookie cache keeps it alive.
 */
import { describe, expect, it } from 'vitest';

import { cookiesOf, PASSWORD, post } from '../__fixtures__/http.js';
import { authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { actingAs, testAuth } from '../testing/index.js';

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'], verifyEmail: 'none' });

describe('auth.sessions', () => {
  it("lists the principal's own sessions without tokens, marking the current one", async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const first = await actingAs(auth, { email: 'ada@notes.test' });
      await actingAs(auth, { email: 'ada@notes.test' });
      await actingAs(auth, { email: 'eve@notes.test' });
      const ada = await auth.principal(first.headers);
      if (ada === null) throw new Error('expected a principal');
      const sessions = await auth.sessions.list(ada);
      expect(sessions).toHaveLength(2);
      expect(sessions.filter(session => session.current)).toEqual([expect.objectContaining({ id: ada.session.id })]);
      for (const session of sessions) expect(Object.keys(session)).not.toContain('token');
    } finally {
      await dispose();
    }
  });

  it("revokes only the owner's session; someone else's id does nothing", async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const ada = await actingAs(auth, { email: 'ada@notes.test' });
      const eve = await actingAs(auth, { email: 'eve@notes.test' });
      const adaPrincipal = await auth.principal(ada.headers);
      const evePrincipal = await auth.principal(eve.headers);
      if (adaPrincipal === null || evePrincipal === null) throw new Error('expected principals');

      await auth.sessions.revoke(evePrincipal, adaPrincipal.session.id);
      expect(await auth.principal(ada.headers)).not.toBeNull();

      await auth.sessions.revoke(adaPrincipal, adaPrincipal.session.id);
      expect(await auth.principal(ada.headers)).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('revokeOthers keeps the current session and ends the rest', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const laptop = await actingAs(auth, { email: 'ada@notes.test' });
      const phone = await actingAs(auth, { email: 'ada@notes.test' });
      const tablet = await actingAs(auth, { email: 'ada@notes.test' });
      const current = await auth.principal(laptop.headers);
      if (current === null) throw new Error('expected a principal');
      await auth.sessions.revokeOthers(current);
      expect(await auth.principal(laptop.headers)).not.toBeNull();
      expect(await auth.principal(phone.headers)).toBeNull();
      expect(await auth.principal(tablet.headers)).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('revokeUser ends every session of a user', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const one = await actingAs(auth, { email: 'ada@notes.test' });
      const two = await actingAs(auth, { email: 'ada@notes.test' });
      await auth.sessions.revokeUser(one.user.id);
      expect(await auth.principal(one.headers)).toBeNull();
      expect(await auth.principal(two.headers)).toBeNull();
    } finally {
      await dispose();
    }
  });

  it('a sign-in replaces the presented session token (no fixation)', async () => {
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      await post(auth, '/sign-up/email', { email: 'ada@notes.test', password: PASSWORD, name: 'Ada' });
      const planted = await actingAs(auth, { email: 'ada@notes.test' });
      const presented = planted.headers.get('cookie') ?? '';
      const signIn = await post(
        auth,
        '/sign-in/email',
        { email: 'ada@notes.test', password: PASSWORD },
        { cookie: presented },
      );
      expect(signIn.status).toBe(200);
      const issued = cookiesOf(signIn);
      expect(issued).toContain('session_token=');
      expect(issued).not.toBe(presented);
      const fresh = await auth.principal(new Headers({ cookie: issued }));
      const old = await auth.principal(planted.headers);
      expect(fresh?.session.id).not.toBe(old?.session.id);
    } finally {
      await dispose();
    }
  });
});
