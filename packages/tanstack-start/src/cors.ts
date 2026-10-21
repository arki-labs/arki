/**
 * The `cors` option of `tanstackStart()`: its source type and the schema `configure` checks it with.
 * Internal on purpose: `./dot` re-exports the type only, so no Zod type reaches the public API.
 */
import { z } from 'zod';

/** An origin is scheme, host and port, with no path: `https://example.com`. */
function isOrigin(value: string): boolean {
  return URL.canParse(value) && new URL(value).origin === value;
}

/** Checks a `CorsOptions` value at `configure`; `dot.test-d.ts` proves it accepts exactly that type. */
export const corsSchema = z
  .object({
    /** Origins the rpc mount reflects, such as the app's own URL. */
    origins: z
      .array(
        z.string().refine(isOrigin, 'Each CORS origin must be scheme://host[:port], with no path or trailing slash.'),
      )
      .readonly(),
    /** Also reflect any `chrome-extension://` origin (bearer-authenticated extensions). */
    extensions: z.boolean().optional(),
  })
  .readonly();
