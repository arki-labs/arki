import { z } from 'zod';

import { defineFailure } from '@arki/failure';

/** A failure `run` returns with status 503: retryable, exit 4. */
export const NotReady = defineFailure('embed.not_ready', {
  status: 503,
  message: 'provider {provider} is not ready',
  remediation: 'Start the provider, then retry.',
  data: z.object({ provider: z.string() }),
});
