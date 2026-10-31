/**
 * The expected ways a dunning operation is refused, each defined once. The dunning services and
 * the notification providers return them, never throw them: a correct caller must branch on them.
 * Bugs and network faults (a provider that cannot be reached at all) are still thrown.
 */
import type { FailureOf, SchemaFailure } from '@arki/failure';
import { z } from '@arki/contracts';
import { defineFailure, isFailure } from '@arki/failure';

import { communicationChannelValues, dunningCampaignStatusValues } from './primitives.js';

/**
 * No dunning campaign has this id.
 *
 * @fix Check the campaign id; list the campaigns to find it.
 * @verify bun run test -- src/dunning/campaign-service.test.ts
 */
export const DunningCampaignNotFound = /* @__PURE__ */ defineFailure('payments.dunning_campaign_not_found', {
  status: 404,
  data: z.object({ campaignId: z.string() }),
  message: 'Dunning campaign {campaignId} not found',
  remediation: 'Check the campaign id; list the campaigns to find it.',
});

/**
 * The campaign exists but is not active, so it cannot run. Nothing was written.
 *
 * @fix Set the campaign status to `active` first.
 * @verify bun run test -- src/dunning/campaign-service.test.ts
 */
export const DunningCampaignNotActive = /* @__PURE__ */ defineFailure('payments.dunning_campaign_not_active', {
  status: 409,
  data: z.object({ campaignId: z.string(), status: z.enum(dunningCampaignStatusValues) }),
  message: 'Dunning campaign {campaignId} is {status}, not active',
  remediation: 'Set the campaign status to active first.',
});

/**
 * The campaign is active but has no active step (template) to send. Nothing was written.
 *
 * @fix Add a step to the campaign, or activate one of its steps.
 * @verify bun run test -- src/dunning/campaign-service.test.ts
 */
export const DunningCampaignWithoutSteps = /* @__PURE__ */ defineFailure('payments.dunning_campaign_without_steps', {
  status: 409,
  data: z.object({ campaignId: z.string() }),
  message: 'Dunning campaign {campaignId} has no active step to send',
  remediation: 'Add a step to the campaign, or activate one of its steps.',
});

/**
 * No customer segment has this id.
 *
 * @fix Check the segment id; list the segments to find it.
 * @verify bun run test -- src/dunning/segmentation-service.test.ts
 */
export const CustomerSegmentNotFound = /* @__PURE__ */ defineFailure('payments.customer_segment_not_found', {
  status: 404,
  data: z.object({ segmentId: z.string() }),
  message: 'Customer segment {segmentId} not found',
  remediation: 'Check the segment id; list the segments to find it.',
});

/**
 * A campaign update removes a step that already sent a communication. The sent message keeps its
 * step (its history points at it), so the update was refused and nothing changed.
 *
 * @fix Keep the step in `templates` (change its content or delay instead), or deactivate the campaign and create a new one.
 * @verify bun run test -- src/dunning/campaign-service.test.ts
 */
export const DunningTemplateInUse = /* @__PURE__ */ defineFailure('payments.dunning_template_in_use', {
  status: 409,
  data: z.object({ templateId: z.string(), stepNumber: z.number() }),
  message: 'Step {stepNumber} ({templateId}) already sent a communication, so it cannot be removed',
  remediation: 'Keep the step in templates and change its content or delay, or deactivate the campaign.',
});

/**
 * A dunning step uses a channel that has no provider registered in this app. The communication
 * was not written.
 *
 * @fix Configure the channel in `createCommunicationOrchestrationService` (or `registerProvider`), or change the step's channel.
 * @verify bun run test -- src/dunning/communication-service.test.ts
 */
export const NotificationChannelUnavailable = /* @__PURE__ */ defineFailure(
  'payments.notification_channel_unavailable',
  {
    status: 503,
    data: z.object({ channel: z.enum(communicationChannelValues) }),
    message: 'No notification provider is registered for the {channel} channel',
    remediation: 'Configure the channel in createCommunicationOrchestrationService, or change the step channel.',
  },
);

/** The channel and provider a notification failure is about. Never an address or a message body. */
const providerTarget = { channel: z.enum(communicationChannelValues), provider: z.string() };

/**
 * The notification provider answered with an error status (4xx or 5xx). The message was not
 * sent. `upstreamMessage` is the provider's own error text when its body had one.
 *
 * @fix Read `upstreamStatus` and `upstreamMessage`: a 4xx is our request (recipient, sender, key); a 5xx is the provider's fault and a later retry can work.
 * @verify bun run test -- src/dunning/communication-service.test.ts
 */
export const NotificationProviderRejected = /* @__PURE__ */ defineFailure('payments.notification_provider_rejected', {
  status: 502,
  data: z.object({ ...providerTarget, upstreamStatus: z.number(), upstreamMessage: z.string().nullable() }),
  message: ({ provider, upstreamStatus, upstreamMessage }) =>
    `${provider} refused the notification with status ${upstreamStatus}${upstreamMessage ? `: ${upstreamMessage}` : ''}`,
  remediation:
    'A 4xx status is our request (recipient, sender, API key); a 5xx status is the provider and a retry can work.',
});

/**
 * The notification provider did not answer within the provider's `timeoutMs`. The message may or
 * may not have been sent.
 *
 * @fix Retry later, or raise `timeoutMs` in the provider config.
 * @verify bun run test -- src/dunning/communication-service.test.ts
 */
export const NotificationProviderTimeout = /* @__PURE__ */ defineFailure('payments.notification_provider_timeout', {
  status: 504,
  data: z.object({ ...providerTarget, timeoutMs: z.number() }),
  message: '{provider} did not answer within {timeoutMs} ms',
  remediation: 'Retry later, or raise timeoutMs in the provider config.',
});

/**
 * The notification provider answered with a success status, but the body is not the shape its API
 * documents. The message may have been sent. `cause` holds the schema failure.
 *
 * @fix Check the provider's API version and its status page; read `cause` for the field that did not match.
 * @verify bun run test -- src/dunning/communication-service.test.ts
 */
export const NotificationProviderResponseInvalid = /* @__PURE__ */ defineFailure(
  'payments.notification_provider_response_invalid',
  {
    status: 502,
    data: z.object({ ...providerTarget, upstreamStatus: z.number() }),
    message: '{provider} answered {upstreamStatus} with a body that is not the documented shape',
    remediation: "Check the provider's API version; the cause names the field that did not match.",
  },
);

/**
 * A webhook recipient URL names a host that is not on the operator's `allowedHosts` list. Nothing
 * was sent. The URL comes from customer metadata, so only hosts the operator listed may be reached.
 *
 * @fix Add the host to `webhook.allowedHosts` if the operator trusts it, or correct the customer's `webhookUrl`.
 * @verify bun run test -- src/dunning/communication-service.test.ts
 */
export const NotificationWebhookHostNotAllowed = /* @__PURE__ */ defineFailure(
  'payments.notification_webhook_host_not_allowed',
  {
    status: 403,
    data: z.object({ host: z.string() }),
    message: 'Webhook host {host} is not on the allowed hosts list',
    remediation: "Add the host to webhook.allowedHosts if the operator trusts it, or correct the customer's webhookUrl.",
  },
);

/**
 * What a notification provider call can return instead of its result. A recipient that is not a
 * valid address for the channel (a webhook URL that is not http or https) is a `SchemaFailure`.
 */
export type NotificationProviderFailure =
  | FailureOf<typeof NotificationProviderRejected>
  | FailureOf<typeof NotificationProviderTimeout>
  | FailureOf<typeof NotificationProviderResponseInvalid>
  | FailureOf<typeof NotificationWebhookHostNotAllowed>
  | SchemaFailure;

/** One item a scheduled tick could not handle: its id, the failure code (`null` for a thrown error) and the message. */
export type DunningTickFault = { id: string; code: string | null; message: string };

/**
 * What one scheduled tick did: how many items it handled, and each item it could not handle. A tick
 * logs every fault too; the report is what the scheduler sees. A fault that stops the whole tick
 * (the database is down) is thrown, not listed.
 */
export type DunningTickReport = { processed: number; failed: DunningTickFault[] };

/** The tick fault for one item: a returned failure keeps its code, a thrown error has none. */
export function tickFault(id: string, fault: unknown): DunningTickFault {
  if (isFailure(fault)) return { id, code: fault.code, message: fault.message };
  return { id, code: null, message: fault instanceof Error ? fault.message : String(fault) };
}
