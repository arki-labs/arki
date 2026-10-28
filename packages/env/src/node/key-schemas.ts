import { PrivateKey, PublicKey } from 'eciesjs';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';
import { is, parse } from '@arki/schema';

declare const publicKeyBrand: unique symbol;
/** A validated secp256k1 public key, distinct from its private key. */
export type EnvPublicKey = string & { readonly [publicKeyBrand]: true };
declare const privateKeyBrand: unique symbol;
/** A validated secp256k1 private key. Never serialize it into diagnostics. */
export type EnvPrivateKey = string & { readonly [privateKeyBrand]: true };
const publicHex = z.string().regex(/^(?:0[23][a-f\d]{64}|04[a-f\d]{128})$/i);
const privateHex = z.string().regex(/^[a-f\d]{64}$/i);

/** Standard Schema for an external public key; issue text never echoes the key. */
export const envPublicKeySchema: StandardSchemaV1<unknown, EnvPublicKey> = z.custom<EnvPublicKey>(value => {
  if (!is(value, publicHex)) return false;
  try {
    PublicKey.fromHex(value, 'secp256k1');
    return true;
  } catch {
    return false;
  }
}, 'Invalid env public key');
/** Standard Schema for an external private key; issue text never echoes the key. */
export const envPrivateKeySchema: StandardSchemaV1<unknown, EnvPrivateKey> = z.custom<EnvPrivateKey>(value => {
  if (!is(value, privateHex)) return false;
  try {
    PrivateKey.fromHex(value, 'secp256k1');
    return true;
  } catch {
    return false;
  }
}, 'Invalid env private key');

/** Parse an external public key without manufacturing a brand. */
export function parsePublicKey(value: unknown) {
  return parse(envPublicKeySchema, value);
}
/** Parse an external private key without exposing its bytes in issues. */
export function parsePrivateKey(value: unknown) {
  return parse(envPrivateKeySchema, value);
}
