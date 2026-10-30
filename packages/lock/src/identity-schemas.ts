import { z } from 'zod';

import { is } from '@arki/schema';

import { MAX_NAME_BYTES } from './types.js';
import { lockToken } from './identities.js';
import type { LockFence, LockKey } from './identities.js';

/** Validates the names that the canonical encoder accepts. */
export const keyNameSchema = z.string().min(1, 'must not be empty')
  .refine(value => !/\p{Cs}/u.test(value), 'must not contain lone surrogates')
  .refine(value => new TextEncoder().encode(value).length <= MAX_NAME_BYTES, `must be at most ${MAX_NAME_BYTES} bytes`);

function keyMember(text: string, offset: number) {
  const delimiter = text.indexOf(':', offset);
  const lengthText = text.slice(offset, delimiter);
  if (delimiter < 0 || !/^[1-9]\d*$/u.test(lengthText)) return;
  const size = Number(lengthText);
  if (size > MAX_NAME_BYTES) return;
  const start = delimiter + 1;
  let end = start;
  let bytes = 0;
  while (end < text.length && bytes < size) {
    const point = text.codePointAt(end) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point <= 0xFFFF ? 3 : 4;
    end += point > 0xFFFF ? 2 : 1;
  }
  const value = text.slice(start, end);
  return bytes === size && keyNameSchema.safeParse(value).success ? { value, end } : undefined;
}

/** Typed decoding is shared by the full-key and metadata schemas. */
export function decodeKey(text: string) {
  const tag = /^1(?:s|rw)?:/u.exec(text)?.[0];
  if (tag === undefined) return;
  const namespace = keyMember(text, tag.length);
  if (namespace === undefined || text[namespace.end] !== ':') return;
  const name = keyMember(text, namespace.end + 1);
  if (name?.end !== text.length) return;
  return { namespace: namespace.value, name: name.value };
}

const keyBase = z.string().refine(text => decodeKey(text) !== undefined);
const fenceBase = z.bigint().nonnegative();

/** Restores a versioned key identity without changing persisted bytes. */
export const lockKeySchema = z.custom<LockKey>(value => is(value, keyBase));
/** Restores an owner token; tokens intentionally have no backend-specific format. */
export const lockTokenSchema = lockToken.schema;
/** Restores a generation read from its owning store. */
export const lockFenceSchema = z.custom<LockFence>(value => is(value, fenceBase));
