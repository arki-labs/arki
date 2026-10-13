import { describe, expectTypeOf, it } from 'vitest';

import type { PathValue, RecordToPath } from './utils.js';

// The previous definitions, kept here as the reference. PathValue now follows the path it is given
// instead of listing every path of T, and falls back to the full list when that walk does not find
// the path. These tests pin that both routes accept the same paths and give the same types.
type OldPathImpl<T, Key extends keyof T> = Key extends string
  ? T[Key] extends Record<string, any>
    ? | `${Key}.${OldPathImpl<T[Key], Exclude<keyof T[Key], keyof any[]>> & string}`
      | `${Key}.${Exclude<keyof T[Key], keyof any[]> & string}`
    : never
  : never;
type OldPathImpl2<T> = OldPathImpl<T, keyof T> | keyof T;
type OldRecordToPath<T> = OldPathImpl2<T> extends string | keyof T ? OldPathImpl2<T> : keyof T;
type OldPathValue<T, P extends OldRecordToPath<T>> = P extends `${infer Key}.${infer Rest}`
  ? Key extends keyof T
    ? Rest extends OldRecordToPath<T[Key]>
      ? OldPathValue<T[Key], Rest>
      : never
    : never
  : P extends keyof T
    ? T[P]
    : never;

type Tree = {
  readonly a: { readonly b: { readonly c: 'hello'; readonly d: number }; readonly e: boolean };
  readonly f: string;
  readonly list: readonly { readonly id: number }[];
  readonly pair: readonly [{ readonly x: 1 }, 2];
  readonly maybe?: { readonly inner: string };
  readonly 0: { readonly zero: true };
};

/** Keys with dots in them: the walk splits at the first dot, so these take the full-list route. */
type Dotted = {
  readonly 'a.b': { readonly c: 'dotted'; readonly charAt: number };
  readonly a: { readonly b: string; readonly 'x.y': { readonly z: 'deep' } };
};

/** A key named like an array member: not a path below the top level, before and now. */
type ArrayNamed = { readonly box: { readonly length: { readonly unit: 'cm' } } };

describe('RecordToPath', () => {
  it('lists the same paths as before', () => {
    expectTypeOf<RecordToPath<Tree>>().toEqualTypeOf<OldRecordToPath<Tree>>();
    expectTypeOf<RecordToPath<Dotted>>().toEqualTypeOf<OldRecordToPath<Dotted>>();
    expectTypeOf<RecordToPath<ArrayNamed>>().toEqualTypeOf<OldRecordToPath<ArrayNamed>>();
    expectTypeOf<RecordToPath<{ a: { b: string } }>>().toEqualTypeOf<'a' | 'a.b'>();
  });
});

describe('PathValue', () => {
  it('reads leaves and intermediate objects', () => {
    expectTypeOf<PathValue<Tree, 'a.b.c'>>().toEqualTypeOf<'hello'>();
    expectTypeOf<PathValue<Tree, 'a.b'>>().toEqualTypeOf<Tree['a']['b']>();
    expectTypeOf<PathValue<Tree, 'f'>>().toEqualTypeOf<string>();
    expectTypeOf<PathValue<Tree, 'pair.0.x'>>().toEqualTypeOf<1>();
    expectTypeOf<PathValue<Tree, 0>>().toEqualTypeOf<{ readonly zero: true }>();
    expectTypeOf<PathValue<Tree, 'maybe'>>().toEqualTypeOf<{ readonly inner: string } | undefined>();
    expectTypeOf<PathValue<Tree, 'a.e' | 'a.b.d'>>().toEqualTypeOf<boolean | number>();
  });

  it('gives the same type as before for every valid path, edge cases included', () => {
    expectTypeOf<PathValue<Tree, RecordToPath<Tree>>>().toEqualTypeOf<OldPathValue<Tree, OldRecordToPath<Tree>>>();
    expectTypeOf<PathValue<Dotted, RecordToPath<Dotted>>>().toEqualTypeOf<
      OldPathValue<Dotted, OldRecordToPath<Dotted>>
    >();
    expectTypeOf<PathValue<Dotted, 'a.b.charAt'>>().toEqualTypeOf<OldPathValue<Dotted, 'a.b.charAt'>>();
    expectTypeOf<PathValue<Dotted, 'a.x.y.z'>>().toEqualTypeOf<OldPathValue<Dotted, 'a.x.y.z'>>();
    expectTypeOf<PathValue<Record<string, { n: number }>, 'any.n'>>().toEqualTypeOf<number>();
  });

  it('rejects paths that RecordToPath does not list', () => {
    // @ts-expect-error -- no such key
    expectTypeOf<PathValue<Tree, 'nope'>>();
    // @ts-expect-error -- no such nested key
    expectTypeOf<PathValue<Tree, 'a.b.x'>>();
    // @ts-expect-error -- past a leaf
    expectTypeOf<PathValue<Tree, 'f.length'>>();
    // @ts-expect-error -- array members are not paths
    expectTypeOf<PathValue<Tree, 'list.length'>>();
    // @ts-expect-error -- a nested key named like an array member is not a path
    expectTypeOf<PathValue<ArrayNamed, 'box.length.unit'>>();
    // @ts-expect-error -- an optional object is not walked into
    expectTypeOf<PathValue<Tree, 'maybe.inner'>>();
    // @ts-expect-error -- number keys only at the top level
    expectTypeOf<PathValue<Tree, '0.zero'>>();
    // @ts-expect-error -- one bad member makes the union invalid
    expectTypeOf<PathValue<Tree, 'a.e' | 'a.zz'>>();
    // @ts-expect-error -- a wide string is not a path
    expectTypeOf<PathValue<Tree, string>>();
  });

  it('accepts a generic path constrained to RecordToPath', () => {
    function read<T, P extends RecordToPath<T>>(_value: T, _path: P): PathValue<T, P> | undefined {
      return undefined;
    }
    const tree: Tree = {
      a: { b: { c: 'hello', d: 1 }, e: true },
      f: 'f',
      list: [],
      pair: [{ x: 1 }, 2],
      0: { zero: true },
    };
    expectTypeOf(read(tree, 'a.b.c')).toEqualTypeOf<'hello' | undefined>();
  });
});
