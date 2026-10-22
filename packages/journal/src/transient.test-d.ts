import { describe, expectTypeOf, it } from 'vitest';

import type { EventStorage } from './index.js';
import { initJournal } from './index.js';
import { j, order, orders, profiles, tables } from './test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it.
describe('the events setting, as types', () => {
  it("accepts only 'stored' | 'transient', on the journal and per entity", () => {
    // Why: the setting is a closed choice. A typo must fail to compile, not fall back to the default.
    expectTypeOf<EventStorage>().toEqualTypeOf<'stored' | 'transient'>();
    initJournal({ tables, events: 'stored' });
    initJournal({ tables, events: 'transient' });
    // @ts-expect-error 'none' is not a storage choice
    initJournal({ tables, events: 'none' });
    j.entity('a', orders, { events: 'transient' });
    j.entity('b', profiles, { key: 'accountId', events: 'stored' });
    // @ts-expect-error 'off' is not a storage choice
    j.entity('c', orders, { events: 'off' });
    expectTypeOf(order.eventStorage).toEqualTypeOf<EventStorage>();
  });
});
