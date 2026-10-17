import { expectTypeOf } from 'vitest';

import type {
  Autocomplete,
  CamelToSnake,
  DeepCamelToSnake,
  DeepPartial,
  DeepRequired,
  DeepSnakeToCamel,
  Lazy,
  Nullable,
  PathValue,
  Prettify,
  RecordToPath,
  Serializable,
  SnakeToCamel,
  Without,
} from './index.js';
import { lazyObject, once, resolveLazy } from './index.js';

// Each assertion below states a promise from the README. They compile or the build fails.

// Prettify: an intersection reads as one object type.
expectTypeOf<Prettify<{ a: string } & { b: number }>>().toEqualTypeOf<{ a: string; b: number }>();

// DeepPartial / DeepRequired: optionality goes all the way down, and back.
expectTypeOf<DeepPartial<{ a: { b: { c: number } } }>>().toEqualTypeOf<{ a?: { b?: { c?: number } } }>();
expectTypeOf<DeepRequired<{ a?: { b?: { c?: number } } }>>().toEqualTypeOf<{ a: { b: { c: number } } }>();

// Nullable: only the chosen keys accept null.
expectTypeOf<Nullable<{ id: string; note: string }, 'note'>>().toEqualTypeOf<{ id: string; note: string | null }>();

// Without: Omit that keeps unions apart instead of flattening them.
expectTypeOf<Without<{ a: 1; b: 2; c: 3 }, 'a' | 'c'>>().toEqualTypeOf<{ b: 2 }>();

// Serializable: function members are dropped.
expectTypeOf<Serializable<{ id: string; save: () => void }>>().toEqualTypeOf<{ id: string }>();

// Casing: strings and keys, one level or all levels.
expectTypeOf<SnakeToCamel<'user_name'>>().toEqualTypeOf<'userName'>();
expectTypeOf<SnakeToCamel<{ user_name: string; nested_obj: { inner_key: 1 } }>>().toEqualTypeOf<{
  userName: string;
  nestedObj: { inner_key: 1 };
}>();
expectTypeOf<DeepSnakeToCamel<{ user_name: string; nested_obj: { inner_key: 1 } }>>().toEqualTypeOf<{
  userName: string;
  nestedObj: { innerKey: 1 };
}>();
expectTypeOf<CamelToSnake<'userName'>>().toEqualTypeOf<'user_name'>();
expectTypeOf<DeepCamelToSnake<{ userName: string; nestedObj: { innerKey: 1 } }>>().toEqualTypeOf<{
  user_name: string;
  nested_obj: { inner_key: 1 };
}>();

// Number keys: snake to camel keeps them, camel to snake drops them.
expectTypeOf<SnakeToCamel<{ user_name: 1; 0: 2 }>>().toEqualTypeOf<{ userName: 1; 0: 2 }>();
expectTypeOf<CamelToSnake<{ userName: 1; 0: 2 }>>().toEqualTypeOf<{ user_name: 1 }>();

// Paths: every dotted key, and the type at one of them.
type Config = { readonly http: { readonly port: 8080; readonly host: 'localhost' }; readonly name: 'api' };
expectTypeOf<RecordToPath<Config>>().toEqualTypeOf<'http' | 'http.port' | 'http.host' | 'name'>();
expectTypeOf<PathValue<Config, 'http.port'>>().toEqualTypeOf<8080>();
expectTypeOf<PathValue<Config, 'http'>>().toEqualTypeOf<Config['http']>();

// A path that does not exist is a compile error, not a runtime surprise.
// @ts-expect-error 'http.missing' is not a path of Config
expectTypeOf<PathValue<Config, 'http.missing'>>();

// Array members are not paths: the list is a leaf.
expectTypeOf<RecordToPath<{ list: { id: number }[] }>>().toEqualTypeOf<'list'>();

// Autocomplete: suggests the literals and still takes any string.
type Size = Autocomplete<'small' | 'large'>;
expectTypeOf<'small'>().toExtend<Size>();
expectTypeOf<'extra-large'>().toExtend<Size>();
expectTypeOf<number>().not.toExtend<Size>();

// Lazy: a value or a function that makes it. resolveLazy gives back the value.
expectTypeOf<Lazy<number>>().toEqualTypeOf<number | (() => number)>();
expectTypeOf(resolveLazy<number>(() => 1)).toEqualTypeOf<number>();

// once and lazyObject keep the type of what they wrap.
expectTypeOf(once(() => ({ ready: true }))).toEqualTypeOf<() => { ready: boolean }>();
expectTypeOf(lazyObject(() => ({ url: 'postgres://db' }))).toEqualTypeOf<{ url: string }>();
