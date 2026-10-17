/**
 * The expected ways a mail is not sent, each defined once with `@arki/failure`. `send`, `sendRaw`,
 * `compose`, `render` and every transport return them in place of the success value; they never
 * throw them. Mistakes in how the package is used (bad config, a bad message) are thrown as
 * `MailError` instead.
 */
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

/**
 * The template's schema refused the input. Nothing was sent.
 *
 * @fix Fix the input to match the template's schema. The same input fails again.
 * @verify bun run test -- src/template.spec.ts
 */
export const MailInvalidInput = defineFailure('mail.invalid_input', {
  status: 422,
  data: z.object({
    template: z.string(),
    /** What the schema reported, with each path as plain keys. */
    issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })),
  }),
  message: ({ template, issues }) =>
    `Input for template "${template}" is invalid: ${issues
      .map(issue => (issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`))
      .join('; ')}`,
  remediation: "Fix the input to match the template's schema; the same input fails again.",
});

/**
 * Every transport is over its monthly quota. Nothing was sent.
 *
 * @fix Add a transport without a quota as a fallback, or raise a quota.
 * @verify bun run test -- src/failover.spec.ts
 */
export const MailQuotaExhausted = defineFailure('mail.quota_exhausted', {
  status: 429,
  data: z.object({ month: z.string() }),
  message: 'Every transport is over its quota for {month}. Nothing was sent.',
  remediation: 'Add a transport without a quota as a fallback, or raise a quota.',
});

/**
 * The service refused the mail, so it surely did not take it. `retryable` is true for HTTP 429
 * and 5xx, when trying later can help. `upstreamStatus` is the service's HTTP status.
 *
 * @fix Retry later when `data.retryable` is true. Otherwise fix the mail or the account settings.
 * @verify bun run test -- src/failover.spec.ts
 */
export const MailRejected = defineFailure('mail.rejected', {
  status: 422,
  data: z.object({
    transport: z.string(),
    retryable: z.boolean(),
    upstreamStatus: z.number().optional(),
    /** The service's own error code or name. */
    providerCode: z.string().optional(),
    /** What the service said. */
    detail: z.string().optional(),
  }),
  message: ({ transport, upstreamStatus, detail }) =>
    `${transport} refused the mail${upstreamStatus === undefined ? '' : ` (HTTP ${upstreamStatus})`}${
      detail === undefined || detail === '' ? '' : `: ${detail}`
    }`,
  remediation: 'When `retryable` is true, send it again later; otherwise fix the message or the transport settings.',
});

/**
 * No readable answer: a timeout, a network failure, or an answer that could not be read. The
 * service may have taken the mail, so trying another service could deliver it twice.
 *
 * @fix Send it again later with the same idempotency key. The service may already have taken it.
 * @verify bun run test -- src/failover.spec.ts
 */
export const MailUncertain = defineFailure('mail.uncertain', {
  status: 503,
  data: z.object({
    transport: z.string(),
    /** What went wrong. */
    detail: z.string(),
    /** The HTTP status of an answer that could not be read. */
    upstreamStatus: z.number().optional(),
  }),
  message: '{transport}: {detail}. The mail may have been sent.',
  remediation: 'Send it again later with the same idempotency key; the service may already have taken it.',
});

/**
 * A queued mail's `expiresAt` passed before it could be sent. Nothing was sent.
 *
 * @fix Queue a new mail, such as a fresh sign-in link.
 * @verify bun run test -- src/mailer.spec.ts
 */
export const MailExpired = defineFailure('mail.expired', {
  status: 410,
  data: z.object({ expiresAt: z.string() }),
  message: 'The mail expired at {expiresAt} before it could be sent.',
  remediation: 'Queue a new mail, such as a fresh sign-in link.',
});
