/**
 * The shape of `errors.json`, the file `arki-error-index` writes. Kept apart
 * from `error-index.ts` so readers (the release tool, the site's generated
 * schema copy) can parse the file without loading the TypeScript compiler or
 * `node:fs`. Import it as `@arki/library-tooling/error-index-schema`.
 */
import { z } from 'zod';

export const errorEntrySchema = z.object({
  code: z.string().min(1),
  package: z.string().min(1),
  kind: z.enum(['thrown', 'failure']),
  what: z.string(),
  fix: z.string().nullable(),
  verify: z.string().nullable(),
  /** `src/file.ts:line`, relative to the package. */
  source: z.string().regex(/^.+:\d+$/),
});
export const errorIndexSchema = z.array(errorEntrySchema);
export type ErrorEntry = z.infer<typeof errorEntrySchema>;
