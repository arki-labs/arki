/** The guards narrow the principal for the handler and keep its exact type. */
import { os } from '@orpc/server';
import { describe, expectTypeOf, it } from 'vitest';

import { errorMap } from '@arki/failure/orpc';

import type { authTables } from './__fixtures__/tables.js';
import type { UserId } from './ids.js';
import type { PrincipalFor } from './pg/types.js';
import { AUTH_FAILURES, AuthenticationRequired, ResourceMissing } from './boundary-failures.js';
import { defineAuth } from './definition.js';
import { assertFound, assertOwnedOrForbidden, assertOwnedOrNotFound, guards } from './orpc.js';

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
      .errors(errorMap(...AUTH_FAILURES))
      .use(authed)
      .handler(({ context }) => {
        expectTypeOf(context.principal).toEqualTypeOf<NotesPrincipal>();
        expectTypeOf(context.principal.user.id).toEqualTypeOf<UserId>();
        expectTypeOf(context.requestId).toEqualTypeOf<string>();
      });
  });

  it('role() keeps the principal type', () => {
    os.$context<Context>()
      .errors(errorMap(...AUTH_FAILURES))
      .use(role('admin'))
      .handler(({ context }) => {
        expectTypeOf(context.principal.user.plan).toEqualTypeOf<'free' | 'pro'>();
      });
  });

  it('without a guard the principal may be null', () => {
    os.$context<Context>()
      .errors(errorMap(...AUTH_FAILURES))
      .handler(({ context }) => {
        expectTypeOf(context.principal).toEqualTypeOf<NotesPrincipal | null>();
      });
  });
});

it('an auth guard requires its exact declared refusal and accepts independent contracts', () => {
  // @ts-expect-error auth.unauthenticated is absent from this contract.
  os.$context<Context>().use(authed);
  os.$context<Context>().errors(errorMap(AuthenticationRequired)).use(authed);
  // @ts-expect-error role also needs auth.forbidden, not only auth.unauthenticated.
  os.$context<Context>().errors(errorMap(AuthenticationRequired)).use(role('admin'));
});

it('ownership assertions require exactly the declared refusals they emit', () => {
  os.handler(({ errors }) => {
    // @ts-expect-error auth.not_found is not declared by the procedure.
    assertFound(null, errors);
    // @ts-expect-error reads also require auth.not_found.
    assertOwnedOrNotFound(null, 'usr_me', errors);
  });
  os.errors(errorMap(ResourceMissing)).handler(({ errors }) => {
    assertFound({ title: 'mine' }, errors);
    assertOwnedOrNotFound({ userId: 'usr_me' }, 'usr_me', errors);
    // @ts-expect-error mutations also require auth.forbidden.
    assertOwnedOrForbidden(null, 'usr_me', errors);
  });
  os.errors(errorMap(...AUTH_FAILURES)).handler(({ errors }) => {
    const row: { userId: string; title: string } | null = { userId: 'usr_me', title: 'mine' };
    assertOwnedOrForbidden(row, 'usr_me', errors);
    expectTypeOf(row.title).toEqualTypeOf<string>();
  });
});
