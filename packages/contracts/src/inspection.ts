/** Identity-preserving schemas for native contracts, metadata and provider capabilities. */
import { z } from 'zod';

import { is } from '@arki/schema';

import type { AnyOperation } from './orpc.js';

/** Native records may include arrays or class instances; inspecting never clones them. */
export const objectSchema = z.custom<object>(value => typeof value === 'object' && value !== null);
/** Inspect callability without replacing a provider or losing its receiver. */
export const callableSchema = z.custom<(...args: never[]) => unknown>(value => typeof value === 'function');
/** Native Zod schema metadata retains the original schema and its transformations. */
export const nativeSchema = z.instanceof(z.ZodType);
/** Each path entry is checked once, retaining native array and accessor semantics. */
const operationPathSchema = z.custom<readonly string[]>(
  value => Array.isArray(value) && Array.prototype.every.call(value, (segment: unknown) => typeof segment === 'string'),
);
/** The public Operation type is the source; its phantom field has no runtime data. */
export const operationSchema = z.custom<AnyOperation>(value => {
  if (!is(value, objectSchema)) return false;
  const path: unknown = Reflect.get(value, 'path');
  const meta: unknown = Reflect.get(value, 'meta');
  return (
    is(path, operationPathSchema) &&
    Reflect.get(value, 'name') === Array.prototype.join.call(path, '.') &&
    is(meta, objectSchema)
  );
});
/** Definition options and provider results are validated without coercion. */
export const idPrefixSchema = z.string();
export const idKindSchema = z.string().min(1);
export const uuidFormatSchema = z.literal('uuid').optional();
// Default invalid-type formatting can inspect a foreign value's constructor before observation owns it.
export const uuidV4Schema = z.string({ error: 'UUID provider must return text.' }).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
/** Drizzle owns the dimension value; inspection retains its native number contract. */
export const dimensionsSchema = z.custom<number>(value => typeof value === 'number');
