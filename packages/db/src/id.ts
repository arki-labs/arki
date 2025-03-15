import { createId as createCuid } from '@paralleldrive/cuid2';

export const createId = () => {
  return createCuid();
};

export const createPrefixedId = (prefix: string) => {
  return `${prefix}${createId()}`;
};
