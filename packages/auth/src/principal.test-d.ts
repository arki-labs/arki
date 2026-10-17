/**
 * The principal's user type comes from the app's table: the branded id, the exposed column's own
 * type, and nothing the definition did not expose.
 */
import { pgSchema, text } from 'drizzle-orm/pg-core';
import { describe, expectTypeOf, it } from 'vitest';

import type { UserId } from './ids.js';
import type { PrincipalFor } from './pg/types.js';
import type { PrincipalOf } from './principal.js';
import { defineAuth } from './definition.js';
import { accountIdColumns, sessionIdColumns, userIdColumns, verificationIdColumns } from './pg/ids.js';
import { createAuthTables } from './pg/schema/index.js';

const tables = createAuthTables(pgSchema('notes'), {
  fill: 'app',
  ids: {
    user: userIdColumns,
    session: sessionIdColumns,
    account: accountIdColumns,
    verification: verificationIdColumns,
  },
  columns: {
    user: {
      plan: text('plan', { enum: ['free', 'pro'] })
        .notNull()
        .default('free'),
      stripeCustomerId: text('stripe_customer_id'),
    },
  },
});

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
});
type NotesPrincipal = PrincipalFor<typeof definition, typeof tables>;

describe('Principal', () => {
  it('reads the user row from the table and the exposed names from the definition', () => {
    expectTypeOf(tables.User.$inferSelect.plan).toEqualTypeOf<'free' | 'pro'>();
    expectTypeOf(definition.user?.fields).toEqualTypeOf<readonly ['plan'] | undefined>();
  });

  it('types the user from the table', () => {
    expectTypeOf<NotesPrincipal['user']['id']>().toEqualTypeOf<UserId>();
    expectTypeOf<NotesPrincipal['user']['plan']>().toEqualTypeOf<'free' | 'pro'>();
    expectTypeOf<NotesPrincipal['user']['email']>().toEqualTypeOf<string>();
    expectTypeOf<NotesPrincipal['user']['image']>().toEqualTypeOf<string | null>();
  });

  it('has no column the definition did not expose', () => {
    expectTypeOf<NotesPrincipal['user']>().not.toHaveProperty('stripeCustomerId');
  });

  it('types the session id from the table', () => {
    expectTypeOf<NotesPrincipal['session']['id']>().toEqualTypeOf<`sess_${string}`>();
  });

  it('exposes only core columns when the definition names none', () => {
    const plain = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password'] });
    expectTypeOf(plain.user).toEqualTypeOf<
      { readonly fields?: readonly []; readonly signUpFields?: readonly never[] } | undefined
    >();
    expectTypeOf<PrincipalFor<typeof plain, typeof tables>['user']>().not.toHaveProperty('plan');
  });

  it('is read back from anything with a principal() method', () => {
    type Fake = { principal: (headers: Headers) => Promise<NotesPrincipal | null> };
    expectTypeOf<PrincipalOf<Fake>>().toEqualTypeOf<NotesPrincipal>();
  });
});
