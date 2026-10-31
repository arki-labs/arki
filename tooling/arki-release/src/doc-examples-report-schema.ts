/**
 * The `arki-doc-examples --json` report, as a consumer reads it. Kept apart
 * from `docs-fresh.ts` (it imports only `zod`) so `site-schema.ts`, and the
 * self-contained copy `site` writes into the app, can use it.
 */
import { z } from 'zod';

export const docExamplesReportSchema = z.object({
  examples: z.number(),
  modules: z.number(),
  compiled: z.number(),
  ran: z.number(),
  skipped: z.number(),
  skippedBlocks: z.array(z.object({ file: z.string(), line: z.number(), reason: z.string() })),
  failures: z.array(z.object({ file: z.string(), line: z.number(), rule: z.string(), message: z.string() })),
});
export type DocExamplesReport = z.infer<typeof docExamplesReportSchema>;
