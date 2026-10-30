import { z } from 'zod';

import { defineFailure } from '@arki/failure';

/** The process environment does not match the schema, so the app must not boot.
 * @fix Set or correct the variables listed in the report, then start the app again.
 * @verify bun run test -- src/core/define-env.test.ts
 */
export const InvalidEnvironment = /* @__PURE__ */ defineFailure('env.invalid_environment', {
  status: 500,
  data: z.object({ report: z.string() }),
  message: data => data.report,
  remediation: 'Set or correct the variables listed in the report, then start the app again.',
});
