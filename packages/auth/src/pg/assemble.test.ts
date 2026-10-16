/**
 * Engine compatibility: every method × bearer × workspaces combination boots on PGlite and
 * serves `/get-session`, and the rows the engine writes get their ids from the app's tables
 * (`generateId: false`), including the workspace models.
 */
import { describe, expect, it } from 'vitest';

import type { AuthMethod } from '../definition.js';
import { allTables, authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { actingAs, testAuth } from '../testing/index.js';

const METHOD_SETS: readonly (readonly AuthMethod[])[] = [
  ['password'],
  ['magicLink'],
  ['google'],
  ['password', 'magicLink', 'google', 'apple', 'facebook', 'microsoft', 'github'],
];

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
  body: JSON.stringify(body),
});

describe('boot matrix', () => {
  for (const methods of METHOD_SETS) {
    for (const bearer of [false, true]) {
      for (const teams of [undefined, false, true]) {
        it(`boots with ${methods.join('+')}, bearer ${bearer}, workspaces ${teams ?? 'off'}`, async () => {
          const definition = defineAuth({
            app: { name: 'Notes', key: 'notes' },
            methods,
            sessions: { bearer },
            ...(teams !== undefined && { workspaces: { teams } }),
          });
          const { auth, dispose } = await testAuth(definition, {
            tables: teams === undefined ? authTables : allTables,
          });
          try {
            const guest = await auth.handler(new Request('http://localhost:3000/api/auth/get-session'));
            expect(guest.status).toBe(200);
            expect(await guest.json()).toBeNull();

            const { headers, user } = await actingAs(
              auth,
              { email: 'ada@notes.test' },
              { via: bearer ? 'bearer' : 'cookie' },
            );
            const session = await auth.handler(new Request('http://localhost:3000/api/auth/get-session', { headers }));
            expect(session.status).toBe(200);
            expect(await session.json()).toMatchObject({ user: { id: user.id, email: 'ada@notes.test' } });
          } finally {
            await dispose();
          }
        });
      }
    }
  }
});

describe('ids come from the tables', () => {
  it('a password sign-up writes a user, an account and a session with the table ids', async () => {
    const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'], verifyEmail: 'none' });
    const { auth, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const response = await auth.handler(
        new Request(
          'http://localhost:3000/api/auth/sign-up/email',
          json({ email: 'ada@notes.test', password: 'correct horse battery', name: 'Ada' }),
        ),
      );
      expect(response.status).toBe(200);
      const principal = await auth.principal(new Headers({ cookie: response.headers.getSetCookie().join('; ') }));
      expect(principal?.user.id).toMatch(/^usr_/);
      expect(principal?.session.id).toMatch(/^sess_/);
    } finally {
      await dispose();
    }
  });

  it('a magic-link request writes a verification row with the table id', async () => {
    const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'] });
    const { auth, mail, dispose } = await testAuth(definition, { tables: authTables });
    try {
      const response = await auth.handler(
        new Request('http://localhost:3000/api/auth/sign-in/magic-link', json({ email: 'ada@notes.test' })),
      );
      expect(response.status).toBe(200);
      expect(mail.sentTo('ada@notes.test')).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it('creating an organization and a team writes rows with the table ids', async () => {
    const definition = defineAuth({
      app: { name: 'Notes', key: 'notes' },
      methods: ['password'],
      workspaces: { teams: true },
    });
    const { auth, dispose } = await testAuth(definition, { tables: allTables });
    try {
      const { headers } = await actingAs(auth, { email: 'ada@notes.test' });
      headers.set('content-type', 'application/json');
      headers.set('origin', 'http://localhost:3000');
      const created = await auth.handler(
        new Request('http://localhost:3000/api/auth/organization/create', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
        }),
      );
      expect(created.status).toBe(200);
      const organization: unknown = await created.json();
      expect(organization).toMatchObject({
        id: expect.stringMatching(/^org_/),
        members: [expect.objectContaining({ id: expect.stringMatching(/^mem_/) })],
      });
      const team = await auth.handler(
        new Request('http://localhost:3000/api/auth/organization/create-team', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'Core', organizationId: Reflect.get(new Object(organization), 'id') }),
        }),
      );
      expect(team.status).toBe(200);
      expect(await team.json()).toMatchObject({ id: expect.stringMatching(/^team_/) });
    } finally {
      await dispose();
    }
  });
});
