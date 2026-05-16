import { describe, it, expectTypeOf } from 'vitest';
import type {
  OfflineSafeProcedure,
  OfflineSafeMeta,
  InferOfflineSafeInput,
} from '../../src/orpc/offline-safe-marker';

describe('OfflineSafeProcedure brand', () => {
  it('requires meta.offlineSafe to be the literal true', () => {
    type Bad = { meta: { offlineSafe: false } };
    type Good = { meta: OfflineSafeMeta; input: { title: string } };

    expectTypeOf<Good>().toMatchTypeOf<OfflineSafeProcedure<Good>>();
    expectTypeOf<Bad>().not.toMatchTypeOf<OfflineSafeProcedure<Bad>>();
  });

  it('extracts the input type via InferOfflineSafeInput', () => {
    type Proc = { meta: OfflineSafeMeta; input: { title: string; body: number } };
    expectTypeOf<InferOfflineSafeInput<Proc>>().toEqualTypeOf<{ title: string; body: number }>();
  });
});
