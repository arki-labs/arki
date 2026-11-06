/**
 * The Zod schema of a `ProviderAttempt` (`failures.ts`), offered to callers by `@arki/geo/zod`. The TS type
 * is the source; `zod.test.ts` locks the two both ways. It lives apart from `failures.ts` so the public
 * entries name no Zod type (`TYPES_E001`).
 */
import { z } from 'zod';

/** A `ProviderAttempt`: one provider's failed try. */
export const providerAttemptSchema = z.object({
  provider: z.string(),
  kind: z.enum(['rate_limited', 'rejected', 'unreachable']),
  message: z.string(),
});
