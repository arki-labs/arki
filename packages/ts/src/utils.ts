export type SnakeToCamel<T> = T extends `${infer A}_${infer B}`
  ? `${Uncapitalize<A>}${Capitalize<SnakeToCamel<B>>}`
  : T extends object
    ? { [K in keyof T as SnakeToCamel<K>]: T[K] }
    : T;

export type DeepSnakeToCamel<T> = T extends `${infer A}_${infer B}`
  ? `${Uncapitalize<A>}${Capitalize<DeepSnakeToCamel<B>>}`
  : T extends object
    ? { [K in keyof T as DeepSnakeToCamel<K>]: DeepSnakeToCamel<T[K]> }
    : T;

export type DeepCamelToSnake<T> = T extends `${infer C0}${infer R}`
  ? `${C0 extends Uppercase<C0> ? '_' : ''}${Lowercase<C0>}${DeepCamelToSnake<R>}`
  : T extends object
    ? {
        [K in keyof T as DeepCamelToSnake<Extract<K, string>>]: DeepCamelToSnake<T[K]>;
      }
    : T;

export type CamelToSnake<T> = T extends `${infer C0}${infer R}`
  ? `${C0 extends Uppercase<C0> ? '_' : ''}${Lowercase<C0>}${CamelToSnake<R>}`
  : T extends object
    ? {
        [K in keyof T as CamelToSnake<Extract<K, string>>]: T[K];
      }
    : T;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type DeepRequired<T> = Required<{
  [P in keyof T]: T[P] extends object | undefined ? DeepRequired<Required<T[P]>> : T[P];
}>;

export type Nullable<T, K extends keyof T> = {
  [P in keyof T]: P extends K ? T[P] | null : T[P];
};

/**
 * Internal type used by RecordToPath
 */
type PathImpl<T, Key extends keyof T> = Key extends string
  ? T[Key] extends Record<string, any>
    ? | `${Key}.${PathImpl<T[Key], Exclude<keyof T[Key], keyof any[]>> & string}`
      | `${Key}.${Exclude<keyof T[Key], keyof any[]> & string}`
    : never
  : never;

/**
 * Used to construct a type union containing all the keys (even if nested) of an object defined as const
 * const obj =  { a: { b: '' }, c: '' }  as const;
 * type Paths = RecordToPath<typeof obj>
 * Paths contains: 'a' | 'a.b' | 'c'
 */
export type RecordToPath<T> = PathImpl<T, keyof T> | keyof T;

/**
 * Internal type used by PathValue: true when P is a nested path of T (the part of a RecordToPath
 * path after a dot: string keys that are not array members, through object values), split at the
 * first dot the way PathValue splits it. It follows P one segment at a time instead of listing
 * every path of T. False only means "not found this way" (for example a key that contains a dot):
 * callers then fall back to RecordToPath.
 */
type IsNestedPath<T, P> = P extends `${infer Key}.${infer Rest}`
  ? Key extends keyof T & string
    ? Key extends keyof unknown[]
      ? false
      : T[Key] extends Record<string, any>
        ? IsNestedPath<T[Key], Rest>
        : false
    : false
  : P extends keyof T & string
    ? P extends keyof unknown[]
      ? false
      : true
    : false;

/**
 * Internal type used by PathCheck: true when P is one of RecordToPath<T>, found by following P.
 * Same caveat as IsNestedPath.
 */
type IsPath<T, P> = P extends keyof T
  ? true
  : P extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T & string
      ? T[Key] extends Record<string, any>
        ? IsNestedPath<T[Key], Rest>
        : false
      : false
    : false;

/**
 * Internal constraint used by PathValue. It accepts exactly RecordToPath<T>: a path found by
 * following it is accepted, anything else is checked against the full RecordToPath<T> (which also
 * gives the error message its list of valid paths). Without the shortcut every use would list every
 * path of T. The check is not distributive over P, so a generic P constrained to RecordToPath<T>
 * still satisfies it.
 */
type PathCheck<T, P> = IsPath<T, P> extends true ? PropertyKey : RecordToPath<T>;

/** Internal type used by PathValue: reads T at a path already known to be valid. */
type ValueAt<T, P> = P extends `${infer Key}.${infer Rest}`
  ? Key extends keyof T
    ? ValueAt<T[Key], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/**
 * Used to read the value of a string path inside an object defined as const
 * const obj =  { a: { b: 'hello' }}  as const;
 * type Value = PathValue<typeof obj, 'a.b'>
 * Value is now a union set containing a single type: 'hello'
 */
export type PathValue<T, P extends PathCheck<T, P>> = P extends `${infer Key}.${infer Rest}`
  ? Key extends keyof T
    ? IsNestedPath<T[Key], Rest> extends true
      ? ValueAt<T[Key], Rest>
      : Rest extends RecordToPath<T[Key]>
        ? PathValue<T[Key], Rest>
        : never
    : never
  : P extends keyof T
    ? T[P]
    : never;

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type IsSerializable<T> = T extends Function ? false : true;

/**
 * Excludes any non-serializable prop from an object
 */
export type Serializable<T> = {
  [K in keyof T as IsSerializable<T[K]> extends true ? K : never]: T[K];
};

/**
 * Enables autocompletion for a union type, while keeping the ability to use any string
 * or type of `T`
 */
export type Autocomplete<U extends T, T = string> = U | (T & Record<never, never>);

/**
 * Omit without union flattening
 * */
export type Without<T, W> = {
  [P in keyof T as Exclude<P, W>]: T[P];
};
