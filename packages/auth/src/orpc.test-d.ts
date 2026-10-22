/** The ownership assertions require exactly the refusals they emit. */
import { os } from '@orpc/server';
import { expectTypeOf, it } from 'vitest';

import { errorMap } from '@arki/failure/orpc';

import { AUTH_FAILURES, ResourceMissing } from './boundary-failures.js';
import { defineAuth } from './definition.js';
import { assertFound, assertOwnedOrForbidden, assertOwnedOrNotFound } from './orpc.js';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
});

it('the definition exposes the declared user fields', () => {
  expectTypeOf(definition.user?.fields).toEqualTypeOf<readonly ['plan'] | undefined>();
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
