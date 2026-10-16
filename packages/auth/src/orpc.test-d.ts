/** The guards narrow the principal for the handler and keep its exact type. */
import { os } from '@orpc/server';
import { describe, expectTypeOf, it } from 'vitest';

import type { authTables } from './__fixtures__/tables.js';
import type { UserId } from './ids.js';
import type { PrincipalFor } from './pg/types.js';
import { defineAuth } from './definition.js';
import { guards } from './orpc.js';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
});
type NotesPrincipal = PrincipalFor<typeof definition, typeof authTables>;
type Context = { readonly principal: NotesPrincipal | null; readonly requestId: string };
const { authed, role } = guards<Context>();

describe('guards typing', () => {
  it('reads the exposed fields from the definition', () => {
    expectTypeOf(definition.user?.fields).toEqualTypeOf<readonly ['plan'] | undefined>();
  });

  it('authed narrows principal to non-null and keeps the other context keys', () => {
    os.$context<Context>()
      .use(authed)
      .handler(({ context }) => {
        expectTypeOf(context.principal).toEqualTypeOf<NotesPrincipal>();
        expectTypeOf(context.principal.user.id).toEqualTypeOf<UserId>();
        expectTypeOf(context.requestId).toEqualTypeOf<string>();
      });
  });

  it('role() keeps the principal type', () => {
    os.$context<Context>()
      .use(role('admin'))
      .handler(({ context }) => {
        expectTypeOf(context.principal.user.plan).toEqualTypeOf<'free' | 'pro'>();
      });
  });

  it('without a guard the principal may be null', () => {
    os.$context<Context>().handler(({ context }) => {
      expectTypeOf(context.principal).toEqualTypeOf<NotesPrincipal | null>();
    });
  });
});
