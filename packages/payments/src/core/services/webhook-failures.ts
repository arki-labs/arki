/**
 * The expected ways `WebhookHandler.processWebhook` does not process an event, each defined once.
 * The handler returns them, it never throws them. Each one carries `retryable` in its data: `true`
 * means a resend can still succeed, so the webhook route must answer non-2xx and the provider resends;
 * `false` means a resend fails the same way, so the route answers 2xx and the provider stops.
 */
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

import { webhookIdSchema } from '../primitives.js';

/**
 * The webhook validator refused the delivery: a bad or missing signature, a source address that is
 * not allowed, a timestamp outside the window, a replayed delivery, or no webhook secret. `reason`
 * is the validator's own text, for logs only; branch on the code. Nothing was stored.
 *
 * @fix Check the webhook secret and the provider's signing setup. A resend of the same delivery is refused again.
 * @verify bun run test -- src/core/services/webhook-handler.test.ts
 */
export const WebhookRejected = /* @__PURE__ */ defineFailure('payments.webhook_rejected', {
  status: 401,
  data: z.object({ reason: z.string(), retryable: z.literal(false) }),
  message: 'The webhook was rejected: {reason}',
  remediation:
    'Check the webhook secret and the provider signing setup; a resend of the same delivery is refused again.',
});

/**
 * The event body does not have the fields the handler reads: no `id` or `type`, or a
 * `data.object` that does not match the event type (a Stripe subscription with no items, a
 * PaymentIntent with no id). `cause` holds the schema's `InvalidInput` when a schema refused it.
 *
 * @fix Nothing to do per event; a resend carries the same body. Check the provider's API version if it repeats.
 * @verify bun run test -- src/core/services/webhook-handler.test.ts
 */
export const WebhookPayloadInvalid = /* @__PURE__ */ defineFailure('payments.webhook_payload_invalid', {
  status: 422,
  data: z.object({ retryable: z.literal(false) }),
  message: 'Invalid webhook payload: the event does not have the fields the handler reads',
  remediation: "Check the provider's webhook API version; a resend carries the same body.",
});

/**
 * The event has been attempted `maxRetries` times and every attempt failed. The handler gives up,
 * so the provider is told to stop resending.
 *
 * @fix Read the stored `errorMessage` of the webhook event, fix its cause, then replay the event by hand.
 * @verify bun run test -- src/core/services/webhook-handler.test.ts
 */
export const WebhookRetriesExhausted = /* @__PURE__ */ defineFailure('payments.webhook_retries_exhausted', {
  status: 422,
  data: z.object({ webhookId: webhookIdSchema, attempts: z.number().int(), retryable: z.literal(false) }),
  message: 'Webhook {webhookId} was given up after {attempts} attempts',
  remediation: 'Read the stored errorMessage of the webhook event, fix its cause, then replay the event by hand.',
});

/**
 * Another delivery of the same event is running it now, inside its lease. This copy did not run it.
 * Not a success: if the running attempt crashes, only a resend processes the event.
 *
 * @fix Nothing; answer non-2xx so the provider resends later.
 * @verify bun run test -- src/core/services/webhook-handler.test.ts
 */
export const WebhookInProgress = /* @__PURE__ */ defineFailure('payments.webhook_in_progress', {
  status: 409,
  data: z.object({ webhookId: webhookIdSchema, retryable: z.literal(true) }),
  message: 'Webhook {webhookId} is being processed',
  remediation: 'Answer non-2xx so the provider resends the event later.',
});

/**
 * The event is about a payment or subscription with no local row for its provider id. Retryable on
 * purpose: the provider can send the webhook before the app's own insert of that row commits, and a
 * later resend then finds it. A subscription made outside the app keeps failing until `maxRetries`
 * gives it up (`WebhookRetriesExhausted`); no owner is invented.
 *
 * @fix Nothing for a row about to commit. For a payment or subscription made outside the app, create it locally first.
 * @verify bun run test -- src/core/services/webhook-handler.test.ts
 */
export const WebhookTargetNotFound = /* @__PURE__ */ defineFailure('payments.webhook_target_not_found', {
  status: 404,
  data: z.object({
    kind: z.enum(['payment', 'subscription']),
    providerId: z.string(),
    retryable: z.literal(true),
  }),
  message: ({ kind, providerId }) => `No local ${kind} for provider ${kind} ${providerId}`,
  remediation: 'Let the provider resend the event; create the row locally first when it was made outside the app.',
});

/**
 * The claim insert conflicted, yet no row holds the event's provider id: the new webhook id collided
 * with another row's, or the winning row was deleted between the two queries. Nothing was processed.
 *
 * @fix Nothing; a resend claims the event again with a new webhook id.
 * @verify bun run test -- src/core/services/webhook-handler.test.ts
 */
export const WebhookClaimConflict = /* @__PURE__ */ defineFailure('payments.webhook_claim_conflict', {
  status: 409,
  data: z.object({ providerEventId: z.string(), retryable: z.literal(true) }),
  message: 'Webhook event {providerEventId} could not be claimed',
  remediation: 'Answer non-2xx so the provider resends the event; the resend claims it with a new webhook id.',
});

/** Every failure `processWebhook` defines for itself. */
export const WEBHOOK_FAILURES = [
  WebhookRejected,
  WebhookPayloadInvalid,
  WebhookRetriesExhausted,
  WebhookInProgress,
  WebhookTargetNotFound,
  WebhookClaimConflict,
] as const;

/** One of `WEBHOOK_FAILURES`. Read `data.retryable` to choose the answer. */
export type WebhookFailure = ReturnType<(typeof WEBHOOK_FAILURES)[number]>;

/** True for a failure from `WEBHOOK_FAILURES`, by its code. */
export function isWebhookFailure(value: unknown): value is WebhookFailure {
  return WEBHOOK_FAILURES.some(definition => definition.is(value));
}
