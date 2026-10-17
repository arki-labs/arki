/** `Prettify`: flatten an intersection so the IDE shows one resolved object type. */

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
