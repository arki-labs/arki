export type Brand<K, T> = K & {
  readonly __brand: T;
};
export type Flavour<K, T> = K & {
  readonly __brand?: T;
};
export type DefaultRecord = Record<string, unknown>;
export type AnyRecord = Record<string, any>;
export type NonNullable$1<T> = T extends null | undefined ? never : T;
