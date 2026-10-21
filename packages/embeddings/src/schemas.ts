/**
 * Schemas for this package's types where they are read back from JSON (recorded fixtures). Not an
 * entry: each schema is locked to its type by an exact two-way type test in `schemas.test.ts`.
 */
import { z } from 'zod';

import { EMBEDDING_PROVIDERS, PURPOSES, QUANTIZATIONS } from './types.js';

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

/** A recorded call's text inputs and the `EmbedOptions` that change its answer; a type test locks it. */
export const embedRequestSchema = z
  .object({
    inputs: z.array(z.string()).readonly(),
    purpose: z.enum(PURPOSES).optional(),
    dimensions: z.number().int().positive().optional(),
    quantization: z.enum(QUANTIZATIONS).exclude(['float32']).optional(),
    onTooLong: z.enum(['fail', 'truncate']).optional(),
  })
  .readonly();
