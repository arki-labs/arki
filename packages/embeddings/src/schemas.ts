/**
 * Schemas for this package's types where they are read back from JSON (recorded fixtures), and the
 * helpers every options schema uses. Not an entry: each schema is locked to its type by an exact
 * two-way type test in `schemas.test.ts`.
 */
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, orThrow } from '@arki/failure';
import { formatIssues, parse, withJsonSchema } from '@arki/schema';

import { ConfigurationFailure } from './failures.js';
import { EMBEDDING_PROVIDERS, PURPOSES, QUANTIZATIONS } from './types.js';

/**
 * An options schema that also answers its JSON Schema. Zod cannot write a function or an object
 * with methods as JSON Schema, so such a field shows as `{}` (any value); the parse still checks it.
 */
export function withOptionsJson<Schema extends z.ZodType>(schema: Schema) {
  return withJsonSchema(
    schema,
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
    z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }),
  );
}

/** A field that must be a function; the type argument names which one. */
export function functionSchema<Fn>() {
  return z.custom<Fn>(value => typeof value === 'function', 'expected a function');
}

/** A field that must be an object (a store, a tokenizer, an `AbortSignal`, a logger); its methods are not checked. */
export function objectSchema<Value extends object>() {
  return z.custom<Value>(value => typeof value === 'object' && value !== null, 'expected an object');
}

/**
 * A factory's options after its schema, or the `ConfigurationFailure` naming each bad field.
 * Factories return failures for bad setup (an empty key from the environment is expected).
 */
export function parseOptions<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  options: unknown,
  label: string,
): Output | ConfigurationFailure {
  const parsed = parse(schema, options);
  if (InvalidInput.is(parsed)) {
    return ConfigurationFailure({ message: `${label} options: ${formatIssues(parsed.data.issues)}` });
  }
  // An async or broken validator is this package's bug, not the caller's setup.
  return orThrow(parsed);
}

/** `Instruction`, the prefixes a provider's options may override; a type test locks it to the type. */
export const instructionSchema = z
  .partialRecord(z.enum(PURPOSES), z.string())
  .readonly()
  .and(z.object({ version: z.number().int() }).readonly());

/** `EmbeddingSpace` as it reads back from JSON; a type test locks it to the type. */
export const spaceSchema = z
  .object({
    provider: z.enum(EMBEDDING_PROVIDERS),
    model: z.string(),
    revision: z.string().optional(),
    dimensions: z.number().int().positive(),
    normalized: z.boolean(),
    quantization: z.enum(QUANTIZATIONS),
    calibration: z.string().optional(),
    instructionVersion: z.number().int(),
  })
  .readonly();

/** `TokenCount` as it reads back from JSON; a type test locks it to the type. */
export const tokenCountSchema = z.union([
  z.object({ basis: z.enum(['reported', 'counted', 'estimated']), count: z.number() }).readonly(),
  z.object({ basis: z.literal('unknown') }).readonly(),
]);

/**
 * The fields of `EmbedOptions`, as a plain object schema so `embedManyOptionsSchema` and
 * `embedStreamOptionsSchema` can extend it. Use `embedOptionsSchema` to check options.
 */
export const embedOptionsFields = z.object({
  purpose: z.enum(PURPOSES).optional(),
  dimensions: z.number().int().positive().optional(),
  quantization: z.enum(QUANTIZATIONS).exclude(['float32']).optional(),
  onTooLong: z.enum(['fail', 'truncate']).optional(),
  signal: objectSchema<AbortSignal>().optional(),
});

/** A recorded call's text inputs and the `EmbedOptions` that change its answer; a type test locks it. */
export const embedRequestSchema = embedOptionsFields
  .pick({ purpose: true, dimensions: true, quantization: true, onTooLong: true })
  .extend({ inputs: z.array(z.string()).readonly() })
  .readonly();
