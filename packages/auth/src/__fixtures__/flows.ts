/**
 * The core flows, written once and run on every database `testAuth` supports: sign-up, session
 * read, sign-out, sign-in, a magic link, and a workspace with a second member. Each database's
 * test file passes a `start` that builds the auth on its own tables.
 */
import { describe, expect, it } from 'vitest';

import type { MailSink } from '@arki/mail/testing';
import { verifyEmail } from '@arki/mail/templates/auth';

import { defineAuth } from '../definition.js';
import { lastLink } from '../testing/index.js';
import { cookiesOf, get, PASSWORD, post } from './http.js';

const app = { name: 'Notes', key: 'notes' } as const;

/** The auths the flows run: one per definition the flows need. */
export const flowDefinitions = {
  password: defineAuth({ app, methods: ['password'], verifyEmail: 'none' }),
  magicLink: defineAuth({ app, methods: ['magicLink'] }),
  // `'send'`: the invitee proves the address before accepting, as the engine requires.
  workspaces: defineAuth({ app, methods: ['password'], verifyEmail: 'send', workspaces: { teams: true } }),
};

export type FlowAuthKind = keyof typeof flowDefinitions;

/** Builds the auth of one kind on the database under test. */
export type StartFlowAuth = (kind: FlowAuthKind) => Promise<{
  readonly auth: Parameters<typeof post>[0];
  readonly mail: MailSink;
  readonly dispose: () => Promise<void>;
}>;

const signUp = (auth: Parameters<typeof post>[0], email: string) =>
  post(auth, '/sign-up/email', { email, password: PASSWORD, name: email.split('@')[0] });

const sessionOf = async (auth: Parameters<typeof post>[0], cookie: string): Promise<unknown> => {
  const response = await get(auth, '/get-session', { cookie });
  return response.json();
};

export function describeAuthFlows(start: StartFlowAuth): void {
  describe('password flows', () => {
    it('signs up, reads the session, signs out, then signs back in with the password only', async () => {
      const { auth, dispose } = await start('password');
      try {
        const created = await signUp(auth, 'ada@notes.test');
        expect(created.status).toBe(200);
        const cookie = cookiesOf(created);
        // Ids come from the tables (`generateId: false`), so they carry the app's prefixes.
        await expect(sessionOf(auth, cookie)).resolves.toMatchObject({
          user: { id: expect.stringMatching(/^usr_/), email: 'ada@notes.test' },
          session: { id: expect.stringMatching(/^sess_/) },
        });

        await expect(post(auth, '/sign-out', {}, { cookie })).resolves.toHaveProperty('status', 200);
        await expect(sessionOf(auth, cookie)).resolves.toBeNull();

        const wrong = await post(auth, '/sign-in/email', { email: 'ada@notes.test', password: 'not my password' });
        expect(wrong.status).toBe(401);
        const signedIn = await post(auth, '/sign-in/email', { email: 'ada@notes.test', password: PASSWORD });
        expect(signedIn.status).toBe(200);
        await expect(sessionOf(auth, cookiesOf(signedIn))).resolves.toMatchObject({
          user: { email: 'ada@notes.test' },
        });
      } finally {
        await dispose();
      }
    });

    it('a magic-link request writes a verification row and sends one mail', async () => {
      const { auth, mail, dispose } = await start('magicLink');
      try {
        const response = await post(auth, '/sign-in/magic-link', { email: 'ada@notes.test' });
        expect(response.status).toBe(200);
        expect(mail.sentTo('ada@notes.test')).toHaveLength(1);
      } finally {
        await dispose();
      }
    });
  });

  describe('workspace flows', () => {
    it('creates an organization and a team, then adds a member through an invitation', async () => {
      const { auth, mail, dispose } = await start('workspaces');
      try {
        const ada = cookiesOf(await signUp(auth, 'ada@notes.test'));
        await signUp(auth, 'bob@notes.test');
        const bob = cookiesOf(await get(auth, lastLink(mail, verifyEmail, 'bob@notes.test')));

        const created = await post(auth, '/organization/create', { name: 'Acme', slug: 'acme' }, { cookie: ada });
        expect(created.status).toBe(200);
        const organization: unknown = await created.json();
        expect(organization).toMatchObject({
          id: expect.stringMatching(/^org_/),
          members: [expect.objectContaining({ id: expect.stringMatching(/^mem_/) })],
        });
        const organizationId: unknown = Reflect.get(new Object(organization), 'id');

        const team = await post(auth, '/organization/create-team', { name: 'Core', organizationId }, { cookie: ada });
        expect(team.status).toBe(200);
        await expect(team.json()).resolves.toMatchObject({ id: expect.stringMatching(/^team_/) });

        const invited = await post(
          auth,
          '/organization/invite-member',
          { email: 'bob@notes.test', role: 'member', organizationId },
          { cookie: ada },
        );
        expect(invited.status).toBe(200);
        const invitation: unknown = await invited.json();
        expect(invitation).toMatchObject({ id: expect.stringMatching(/^inv_/), status: 'pending' });

        const accepted = await post(
          auth,
          '/organization/accept-invitation',
          { invitationId: Reflect.get(new Object(invitation), 'id') },
          { cookie: bob },
        );
        expect(accepted.status).toBe(200);

        const members = await get(auth, `/organization/list-members?organizationId=${String(organizationId)}`, {
          cookie: ada,
        });
        expect(members.status).toBe(200);
        await expect(members.json()).resolves.toMatchObject({
          members: expect.arrayContaining([
            expect.objectContaining({ role: 'owner' }),
            expect.objectContaining({ role: 'member', user: expect.objectContaining({ email: 'bob@notes.test' }) }),
          ]),
        });
      } finally {
        await dispose();
      }
    });
  });
}
