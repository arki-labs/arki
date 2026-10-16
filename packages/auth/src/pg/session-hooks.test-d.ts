/**
 * `sessionCreating` returns the app's own session columns, typed from the session table and
 * written nowhere else: an unknown name, an engine column or a wrong value type does not compile.
 */
import { describe, expectTypeOf, it } from 'vitest';

import type { UserIdOf } from '../principal.js';
import type { AuthDb } from './types.js';
import { sessionTables } from '../__fixtures__/session-tables.js';
import { defineAuth } from '../definition.js';
import { auth } from '../dot.js';
import { createAuth } from './index.js';

declare const db: AuthDb;
const definition = defineAuth({ app: { name: 'Games', key: 'games' }, methods: ['google'] });
const runtime = () => ({
  url: 'http://localhost:3000',
  secret: undefined,
  production: false,
  providers: { google: { clientId: 'id', clientSecret: 'secret' } },
});
const tables = sessionTables;

describe('sessionCreating', () => {
  it('takes the table user id and returns the extra columns', () => {
    createAuth(definition, {
      db,
      tables,
      runtime,
      on: {
        sessionCreating: ({ userId }) => {
          expectTypeOf(userId).toEqualTypeOf<UserIdOf<typeof tables>>();
          return { appContext: 'wordle' };
        },
        sessionCreated: ({ userId, session }) => {
          expectTypeOf(userId).toEqualTypeOf<UserIdOf<typeof tables>>();
          expectTypeOf(session.id).toEqualTypeOf<(typeof tables.Session.$inferSelect)['id']>();
        },
      },
    });
    createAuth(definition, { db, tables, runtime, on: { sessionCreating: () => Promise.resolve() } });
  });

  it('refuses an unknown column name next to a known one', () => {
    createAuth(definition, {
      db,
      tables,
      runtime,
      // @ts-expect-error `appContxt` is not a column of the session table
      on: { sessionCreating: () => ({ appContext: 'wordle', appContxt: 'typo' }) },
    });
    createAuth(definition, {
      db,
      tables,
      runtime,
      // @ts-expect-error an async hook is checked the same way
      on: { sessionCreating: () => Promise.resolve({ appContext: 'wordle', appContxt: 'typo' }) },
    });
  });

  it('refuses an engine column and a wrong value type', () => {
    createAuth(definition, {
      db,
      tables,
      runtime,
      // @ts-expect-error the engine writes `token` itself
      on: { sessionCreating: () => ({ token: 'stolen' }) },
    });
    createAuth(definition, {
      db,
      tables,
      runtime,
      // @ts-expect-error `appContext` is text
      on: { sessionCreating: () => ({ appContext: 42 }) },
    });
  });

  it('is checked the same way through the Dot plugin', () => {
    auth(definition, {
      tables,
      runtime,
      // @ts-expect-error `appContxt` is not a column of the session table
      on: { sessionCreating: () => ({ appContext: 'wordle', appContxt: 'typo' }) },
    });
  });
});
