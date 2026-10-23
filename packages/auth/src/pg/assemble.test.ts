/**
 * Engine compatibility: every method × bearer × workspaces combination boots on PGlite and
 * serves `/get-session`; the core flows (`../__fixtures__/flows.ts`) run on PGlite, as they do on
 * libSQL in `../sqlite/flows.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { AuthMethod } from '../definition.js';
import { describeAuthFlows, flowDefinitions } from '../__fixtures__/flows.js';
import { allTables, authTables } from '../__fixtures__/tables.js';
import { defineAuth } from '../definition.js';
import { actingAs, testAuth } from '../testing/index.js';

const METHOD_SETS: readonly (readonly AuthMethod[])[] = [
  ['password'],
  ['magicLink'],
  ['google'],
  ['password', 'magicLink', 'google', 'apple', 'facebook', 'microsoft', 'github'],
];

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

describeAuthFlows(async kind =>
  kind === 'workspaces'
    ? testAuth(flowDefinitions.workspaces, { tables: allTables })
    : testAuth(flowDefinitions[kind], { tables: authTables }),
);
