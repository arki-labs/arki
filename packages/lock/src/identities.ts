import { defineId } from '@arki/contracts';
import type { IdOf } from '@arki/contracts';

/** Canonical resource identity; its versioned encoding is unchanged across replicas. */
declare const lockKeyBrand: unique symbol;
export type LockKey = string & { readonly [lockKeyBrand]: true };

/** A distinct owner for one acquisition attempt, never a resource key. */
export const lockToken = defineId('', {
  kind: 'lock.owner',
  format: { alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789', length: 24 },
});
export type LockToken = IdOf<typeof lockToken>;

/** A generation accepted by the protected resource, never an owner token. */
declare const lockFenceBrand: unique symbol;
export type LockFence = bigint & { readonly [lockFenceBrand]: true };
