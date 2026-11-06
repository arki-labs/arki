/**
 * The input schemas of the webhook sender. Internal: `webhooks.ts` parses `subscribe` and `dispatch` input
 * with them. The TS types (`SubscribeInput`, `DispatchInput`) are the source; `webhook-schemas.test-d.ts` locks
 * each schema to its type both ways. They live apart so `./http/webhooks` names no Zod type (`TYPES_E001`).
 */
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { validatePublicURL } from '@arki/http/public-fetch';

/** A subscriber URL: public https only, refused here so a partner cannot point deliveries at a private address. */
const publicHttpsUrl = z.url().superRefine((url, ctx) => {
  const checked = validatePublicURL(url);
  // An unparsable URL is already an issue of `z.url()`.
  if (isFailure(checked)) {
    if (checked.data.reason !== 'invalid_url') ctx.addIssue({ code: 'custom', message: checked.message });
  } else if (checked.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'The URL must use https.' });
});
/** A `SubscribeInput`. */
export const subscribeInput = z
  .object({
    partner: z.string().min(1).max(256),
    url: publicHttpsUrl,
    events: z.array(z.string().min(1).max(128)).min(1).readonly(),
  })
  .readonly();
/** A `DispatchInput`. */
export const dispatchInput = z
  .object({
    partner: z.string().min(1).max(256),
    event: z.string().min(1).max(128),
    payload: z.unknown(),
  })
  .readonly();
