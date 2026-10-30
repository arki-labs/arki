import { describe, expectTypeOf, it } from 'vitest';

import type { CreateForemanClientOptions } from './client';
import type { FetchFleetSnapshotOptions } from './server';

// Only what the clients call. Not assignable to `typeof fetch`, which is the point.
const wrapper = (_url: URL, _init: RequestInit) => Promise.resolve(new Response());

describe('the fetch option', () => {
  it('takes a wrapper with none of a runtime fetch extras', () => {
    expectTypeOf(wrapper).toExtend<NonNullable<CreateForemanClientOptions['fetch']>>();
    expectTypeOf(wrapper).toExtend<NonNullable<FetchFleetSnapshotOptions['fetch']>>();
  });

  it('still takes the global fetch', () => {
    expectTypeOf(fetch).toExtend<NonNullable<CreateForemanClientOptions['fetch']>>();
    expectTypeOf(fetch).toExtend<NonNullable<FetchFleetSnapshotOptions['fetch']>>();
  });
});
