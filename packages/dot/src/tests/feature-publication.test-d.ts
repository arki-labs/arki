/** Published wire keys must keep service alternatives and property modifiers through feature qualification. */
import { expectTypeOf } from 'vitest';

import type { Failure } from '@arki/failure';

import type { FeatureUnit } from '../define-feature.js';
import type { EmptyShape, UnitProvides, ServiceRecord } from '../unit-contract.js';

type PublicOnly<Services, Name extends string> = Services extends unknown
  ? Pick<Services, Exclude<keyof Services, `${Name}.usecases` | `${Name}.services` | `feature.${Name}`>>
  : never;
type Published<Name extends string, Values extends ServiceRecord> = PublicOnly<
  UnitProvides<FeatureUnit<Name, EmptyShape, readonly [], readonly [], EmptyShape, Values, readonly []>>,
  Name
>;
declare const hidden: unique symbol;
type Values = { readonly optional?: Promise<string>; count: number | Failure; 7: boolean; [hidden]: Date };
// Publication preserves optional and readonly properties, filters non-wire keys and unwraps successful values.
expectTypeOf<Published<'plain', Values>>().toEqualTypeOf<{ readonly optional?: string; readonly count: number }>();
expectTypeOf<Published<'parent.child', Values>>().toEqualTypeOf<{
  readonly 'parent.child.optional'?: string;
  readonly 'parent.child.count': number;
}>();
expectTypeOf<Published<'plain#eu', Values>>().toEqualTypeOf<{
  readonly 'plain#eu.optional'?: string;
  readonly 'plain#eu.count': number;
}>();
// A union of service records retains each branch, including keys absent from the other branch.
type Alternatives = { a: number; shared?: string } | { b: boolean; shared?: number };
expectTypeOf<Published<'plain', Alternatives>>().toEqualTypeOf<
  { readonly a: number; readonly shared?: string } | { readonly b: boolean; readonly shared?: number }
>();
expectTypeOf<Published<'parent.child', Alternatives>>().toEqualTypeOf<
  | { readonly 'parent.child.a': number; readonly 'parent.child.shared'?: string }
  | { readonly 'parent.child.b': boolean; readonly 'parent.child.shared'?: number }
>();
// A union name preserves the existing all-nested/all-instanced qualification rule.
expectTypeOf<Published<'plain' | 'parent.child', { value: number }>>().toEqualTypeOf<{ readonly value: number }>();
expectTypeOf<Published<'a.child' | 'b.child', { value: number }>>().toEqualTypeOf<{
  readonly 'a.child.value': number;
  readonly 'b.child.value': number;
}>();
expectTypeOf<Published<'parent.child' | 'plain#eu', { value: number }>>().toEqualTypeOf<{ readonly value: number }>();
