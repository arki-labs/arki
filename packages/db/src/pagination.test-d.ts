import { pgTable, text } from 'drizzle-orm/pg-core';
import { expectTypeOf, it } from 'vitest';

import type { FailureOf } from '@arki/failure';
import { keyset } from '@arki/contracts';

import { keysetQuery } from './pagination.js';

const order = keyset({ id: 'asc' });
const _query = keysetQuery(order, pgTable('items', { id: text('id').primaryKey() }));
it('preserves each codec failure without adding unrelated pagination failures', () => {
  expectTypeOf<FailureOf<typeof _query.after>>().toEqualTypeOf<FailureOf<typeof order.decode>>();
  expectTypeOf<FailureOf<typeof _query.page>>().toEqualTypeOf<FailureOf<typeof order.encode>>();
});
