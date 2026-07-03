import { createId as createCuid } from '@paralleldrive/cuid2';

export const createId = () => {
  return createCuid();
};

export const createPrefixedId = <T extends string>(prefix: T): `${T}${string}` => {
  return `${prefix}${createId()}`;
};

// Re-export the new ID factory
export * from './id-factory.js';
