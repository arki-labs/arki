/**
 * Refund notifications: an approval request to the admins, a status mail to the customer, and a
 * failure alert to support. Email goes through a transport the app passes in (payments sends no
 * mail of its own); Slack posts to an incoming-webhook URL. A send that did not go out returns
 * `NotificationFailed`; a misconfigured service throws when it is built, never on the first send.
 */
import type { Failure } from '@arki/failure';
import { z } from '@arki/contracts';
import { now } from '@arki/date';
import { isFailure } from '@arki/failure';

import type { Refund } from '../../refunds/types.js';
import type { PaymentRepository } from '../repository.js';
import { refundAmountOf } from '../../refunds/repository.js';
import { misconfigured, NotificationFailed } from '../failures.js';
import { ReferenceNotFound } from '../providers/provider-error.js';
import { observePayments } from '../telemetry.js';

/**
 * Sends refund notifications. Each method resolves with nothing when the notification went out,
 * or with an `@arki/failure` value when it did not. The refund itself never depends on it.
 */
export type NotificationService = {
  sendRefundApprovalRequest?(refund: Refund): Promise<void | Failure>;
  sendRefundStatusUpdate?(refund: Refund, status: string): Promise<void | Failure>;
  sendRefundFailureAlert?(refund: Refund, error: unknown): Promise<void | Failure>;
};

/** Which notification a send is, as `NotificationFailed` names it. */
type NotificationKind = ReturnType<typeof NotificationFailed>['data']['notification'];

/** One plain-text mail. */
export type NotificationMail = { to: readonly string[]; subject: string; text: string };

/**
 * Sends one mail through the app's own transport, such as `mailer.sendRaw` from `@arki/mail`.
 * Resolve with an `@arki/failure` value when the mail was not sent; any other value means sent.
 */
export type SendNotificationMail = (mail: NotificationMail) => Promise<unknown>;

export type EmailNotificationConfig = {
  /** Who gets the approval requests. At least one address. */
  adminEmails: readonly string[];
  /** Who gets the failure alerts. */
  supportEmail: string;
  /** The app's mail transport. Payments builds no mailer of its own. */
  send: SendNotificationMail;
  /** Finds the customer of a refund's payment, whose address gets the status mail. A `PaymentRepository` fits. */
  reads: Pick<PaymentRepository, 'findPaymentById' | 'findCustomerById'>;
};

const emailConfigSchema = z.object({
  adminEmails: z.array(z.email()).min(1),
  supportEmail: z.email(),
  send: z.custom<SendNotificationMail>(value => typeof value === 'function', 'send must be a function'),
  reads: z.object({
    findPaymentById: z.custom<unknown>(
      value => typeof value === 'function',
      'reads.findPaymentById must be a function',
    ),
    findCustomerById: z.custom<unknown>(
      value => typeof value === 'function',
      'reads.findCustomerById must be a function',
    ),
  }),
});

/** Throws `payments.configuration_invalid` for `setting` when `config` does not match `schema`; the problem lists each bad field. */
function checkNotificationConfig(config: unknown, schema: z.ZodType, setting: string): void {
  const checked = schema.safeParse(config);
  if (checked.success) return;
  throw misconfigured(setting, checked.error.issues.map(issue => `${issue.path.join('.') || '(config)'}: ${issue.message}`).join('; '));
}

/** Refund notifications by mail, sent through the transport the app passes in. */
export class EmailNotificationService implements NotificationService {
  private readonly config: EmailNotificationConfig;

  /** Throws `payments.configuration_invalid` for a config without a transport, reads, an admin address or a valid support address. */
  constructor(config: EmailNotificationConfig) {
    checkNotificationConfig(config, emailConfigSchema, 'notifications.email');
    this.config = config;
  }

  async sendRefundApprovalRequest(refund: Refund) {
    return this.mail('refund_approval_request', {
      to: this.config.adminEmails,
      subject: `Refund Request Pending Approval - ${refund.id}`,
      text: [
        `Refund ${refund.id} is waiting for approval.`,
        `Amount: ${refundAmountOf(refund).toString()}`,
        `Reason: ${refund.reason}`,
        `Customer note: ${refund.customerNote || 'None'}`,
      ].join('\n'),
    });
  }

  /** Mails the customer of the refund's payment. `ReferenceNotFound` when the payment or its customer is gone. */
  async sendRefundStatusUpdate(refund: Refund, status: string) {
    const payment = await this.config.reads.findPaymentById(refund.paymentId);
    if (!payment) return ReferenceNotFound({ kind: 'payment', id: refund.paymentId, missing: 'row' });

    const customer = await this.config.reads.findCustomerById(payment.customerId);
    if (!customer) return ReferenceNotFound({ kind: 'customer', id: payment.customerId, missing: 'row' });

    return this.mail('refund_status_update', {
      to: [customer.email],
      subject: `Refund ${status.toUpperCase()} - ${refund.id}`,
      text: [`Your refund ${refund.id} is ${status}.`, `Amount: ${refundAmountOf(refund).toString()}`].join('\n'),
    });
  }

  async sendRefundFailureAlert(refund: Refund, error: unknown) {
    return this.mail('refund_failure_alert', {
      to: [this.config.supportEmail],
      subject: `URGENT: Refund Processing Failed - ${refund.id}`,
      text: [
        `Refund ${refund.id} failed.`,
        `Amount: ${refundAmountOf(refund).toString()}`,
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        `Failed at: ${now().toString()}`,
      ].join('\n'),
    });
  }

  private async mail(notification: NotificationKind, mail: NotificationMail) {
    return observePayments(
      'notification',
      { 'payments.channel': 'email', 'payments.notification': notification },
      async () => {
        const sent = await this.config.send(mail);
        if (isFailure(sent)) return NotificationFailed({ channel: 'email', notification }, { cause: sent });
        return;
      },
    );
  }
}

export type SlackNotificationConfig = {
  /** The Slack incoming-webhook URL. It is a secret: it is never logged. */
  webhookUrl: string;
  adminChannel: string;
  supportChannel: string;
  /** Base URL of the admin app; used to build action button links. */
  adminUrl: string;
  /** How long one post may take before it counts as failed. Default 10 seconds. */
  timeoutMs?: number;
};

const slackConfigSchema = z.object({
  webhookUrl: z.url({ protocol: /^https?$/ }),
  adminChannel: z.string().min(1),
  supportChannel: z.string().min(1),
  adminUrl: z.url(),
  timeoutMs: z.number().int().positive().optional(),
});

/** Refund notifications posted to a Slack incoming webhook. */
export class SlackNotificationService implements NotificationService {
  private readonly config: SlackNotificationConfig;

  /** Throws `payments.configuration_invalid` for a config without a valid webhook URL, channels or admin URL. */
  constructor(config: SlackNotificationConfig) {
    checkNotificationConfig(config, slackConfigSchema, 'notifications.slack');
    this.config = config;
  }

  async sendRefundApprovalRequest(refund: Refund) {
    return this.post('refund_approval_request', {
      channel: this.config.adminChannel,
      text: `🔄 New refund request requires approval`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Refund ID:* ${refund.id}\n*Amount:* ${refundAmountOf(refund).toString()}\n*Reason:* ${refund.reason}\n*Customer Note:* ${refund.customerNote || 'None'}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              url: `${this.config.adminUrl}/refunds/${refund.id}/approve`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject' },
              style: 'danger',
              url: `${this.config.adminUrl}/refunds/${refund.id}/reject`,
            },
          ],
        },
      ],
    });
  }

  /** Posts the new status to the admin channel. */
  async sendRefundStatusUpdate(refund: Refund, status: string) {
    const emoji = status === 'completed' ? '✅' : status === 'rejected' ? '❌' : '⏳';
    return this.post('refund_status_update', {
      channel: this.config.adminChannel,
      text: `${emoji} Refund ${refund.id} ${status}`,
    });
  }

  async sendRefundFailureAlert(refund: Refund, error: unknown) {
    return this.post('refund_failure_alert', {
      channel: this.config.supportChannel,
      text: `🚨 URGENT: Refund processing failed`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Refund ID:* ${refund.id}\n*Amount:* ${refundAmountOf(refund).toString()}\n*Error:* ${error instanceof Error ? error.message : 'Unknown error'}\n*Failed At:* ${now().toString()}`,
          },
        },
      ],
    });
  }

  /** POSTs `message` as JSON. A non-2xx answer, a network error or the timeout returns `NotificationFailed`. */
  private async post(notification: NotificationKind, message: Record<string, unknown>) {
    return observePayments(
      'notification',
      { 'payments.channel': 'slack', 'payments.notification': notification },
      async () => {
        let response: Response;
        try {
          response = await fetch(this.config.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
          });
        } catch (error) {
          // Unreachable host, refused connection or the timeout: the message did not go out
          return NotificationFailed({ channel: 'slack', notification }, { cause: error });
        }
        // Free the connection; Slack answers a short `ok` we do not need
        await response.body?.cancel();
        if (!response.ok) return NotificationFailed({ channel: 'slack', notification, status: response.status });
        return;
      },
    );
  }
}

/**
 * Sends every notification on each channel. Every channel is tried; the first failure is returned.
 */
export class MultiChannelNotificationService implements NotificationService {
  constructor(private readonly services: readonly NotificationService[]) {}

  async sendRefundApprovalRequest(refund: Refund) {
    const results = await Promise.all(this.services.map(async service => service.sendRefundApprovalRequest?.(refund)));
    return results.find(result => isFailure(result));
  }

  async sendRefundStatusUpdate(refund: Refund, status: string) {
    const results = await Promise.all(
      this.services.map(async service => service.sendRefundStatusUpdate?.(refund, status)),
    );
    return results.find(result => isFailure(result));
  }

  async sendRefundFailureAlert(refund: Refund, error: unknown) {
    const results = await Promise.all(
      this.services.map(async service => service.sendRefundFailureAlert?.(refund, error)),
    );
    return results.find(result => isFailure(result));
  }
}

export type NotificationServiceConfig =
  | { type: 'email'; email: EmailNotificationConfig }
  | { type: 'slack'; slack: SlackNotificationConfig }
  | { type: 'multi'; email?: EmailNotificationConfig; slack?: SlackNotificationConfig };

const multiConfigSchema = z
  .object({ email: z.unknown().optional(), slack: z.unknown().optional() })
  .refine(config => config.email !== undefined || config.slack !== undefined, 'multi needs email, slack or both');

/**
 * Builds the notification service a config names. Throws `payments.configuration_invalid` at boot for a config that
 * cannot send: no transport, no webhook URL, a bad address, or a `multi` with no channel.
 *
 * @example
 * const notifications = createNotificationService({
 *   type: 'email',
 *   email: {
 *     adminEmails: ['admin@example.com'],
 *     supportEmail: 'support@example.com',
 *     send: mail => mailer.sendRaw(mail),
 *     reads: paymentRepository,
 *   },
 * });
 */
export function createNotificationService(config: NotificationServiceConfig): NotificationService {
  switch (config.type) {
    case 'email': {
      return new EmailNotificationService(config.email);
    }
    case 'slack': {
      return new SlackNotificationService(config.slack);
    }
    case 'multi': {
      checkNotificationConfig(config, multiConfigSchema, 'notifications.multi');
      const services: NotificationService[] = [];
      if (config.email) services.push(new EmailNotificationService(config.email));
      if (config.slack) services.push(new SlackNotificationService(config.slack));
      return new MultiChannelNotificationService(services);
    }
  }
}
