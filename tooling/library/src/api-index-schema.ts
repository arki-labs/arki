/**
 * The shape of `api.json`, the file `arki-api-index` writes. Kept apart from
 * `api-index.ts` so readers (the site, `arki-api-diff`) can parse the file
 * without loading the TypeScript compiler or `node:fs`. Import it as
 * `@arki/library-tooling/api-index-schema`.
 */
import { z } from 'zod';

export const API_KINDS = [
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'variable',
  'namespace',
  'unknown',
] as const;

export const apiEntrySchema = z.object({
  subpath: z.string(),
  name: z.string(),
  kind: z.enum(API_KINDS),
  signature: z.string(),
  jsdocSummary: z.string(),
});

/**
 * Many exports of one kind and one declared type. `signature` is the shared
 * type text (`Icon`), `namesFile` is relative to the folder of `api.json` and
 * holds the sorted names as a JSON string array.
 */
export const apiGroupSchema = z.object({
  subpath: z.string(),
  kind: z.enum(API_KINDS),
  signature: z.string(),
  count: z.number().int().positive(),
  namesFile: z.string(),
});

/** `errorCodes` are the codes of `buildErrorIndex` for the same package (`dist/errors.json` holds the details). */
export const apiIndexSchema = z.object({
  package: z.string(),
  version: z.string(),
  entries: z.array(apiEntrySchema),
  /** Absent in `api.json` files written before grouping existed. */
  groups: z.array(apiGroupSchema).default([]),
  errorCodes: z.array(z.string()),
});

export type ApiEntry = z.infer<typeof apiEntrySchema>;
export type ApiGroup = z.infer<typeof apiGroupSchema>;
export type ApiIndex = z.infer<typeof apiIndexSchema>;
