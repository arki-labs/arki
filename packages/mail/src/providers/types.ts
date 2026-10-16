import type { StandardSchemaV1 } from '@arki/schema';
import type * as React from 'react';

/**
 * Provider-agnostic email payload.
 *
 * `react` is kept for backward compatibility with the low-level `send()` helper
 * which passes it directly to the Resend SDK. For new typed email procedures,
 * pre-render React to `html` before sending.
 */
export type SendEmailPayload = {
  to: string | string[];
  from: string;
  subject: string;
  html?: string;
  text?: string;
  /** @deprecated Pass pre-rendered html instead. Supported only by ResendProvider. */
  react?: React.ReactElement | React.ReactNode | null;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | string[];
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  /** ISO 8601 datetime for scheduled delivery (provider support varies). */
  scheduledAt?: string;
};

export type SendEmailResult = {
  /** Provider-assigned message ID, or null on failure. */
  data: { id: string } | null;
  /**
   * `issues` is set only on a `ValidationError` from `EmailProcedure.send`:
   * exactly what the input schema reported, paths included.
   */
  error: { message: string; name: string; issues?: readonly StandardSchemaV1.Issue[] } | null;
};

/**
 * Abstraction over a transactional email delivery service.
 *
 * Implement this interface to add a new provider (Resend, Unosend, SMTP, etc.).
 */
export type EmailProvider = {
  /** Unique identifier used in logs and quota tracking. */
  name: string;
  /**
   * Approximate monthly send quota for this provider.
   * Used by the quota router to decide which provider to use.
   * Omit for unlimited (always eligible).
   */
  quotaPerMonth?: number;
  /**
   * Deliver a single email.
   *
   * @returns `{ data, error }` — never throws; errors are surfaced via `error`.
   */
  send(payload: SendEmailPayload): Promise<SendEmailResult>;
};
