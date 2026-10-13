import { now } from '@arki/date';

import type { Refund } from '../../refunds/types.js';
import { refundAmountOf } from '../../refunds/repository.js';

/**
 * Notification Service Interface
 * Defines the contract for sending notifications related to refunds
 */
export type NotificationService = {
  sendRefundApprovalRequest?(refund: Refund): Promise<void>;
  sendRefundStatusUpdate?(refund: Refund, status: string): Promise<void>;
  sendRefundFailureAlert?(refund: Refund, error: unknown): Promise<void>;
}

/**
 * Email-based Notification Service Implementation
 * Simple implementation that would typically integrate with an email service
 */
export class EmailNotificationService implements NotificationService {
  constructor(private readonly emailConfig: EmailNotificationConfig) {}

  async sendRefundApprovalRequest(refund: Refund): Promise<void> {
    // In a real implementation, this would send an email to admins
    console.log(`[EMAIL] Refund approval request for ${refund.id}`, {
      to: this.emailConfig.adminEmails,
      subject: `Refund Request Pending Approval - ${refund.id}`,
      refundId: refund.id,
      amount: refundAmountOf(refund).toString(),
      reason: refund.reason,
      requestedBy: refund.requestedBy,
    });

    // Example integration with email service:
    // await this.emailService.send({
    //   to: this.emailConfig.adminEmails,
    //   from: this.emailConfig.fromEmail,
    //   subject: `Refund Request Pending Approval - ${refund.id}`,
    //   template: 'refund-approval-request',
    //   variables: {
    //     refundId: refund.id,
    //     amount: refund.refundAmount,
    //     reason: refund.reason,
    //     customerNote: refund.customerNote,
    //     requestedAt: refund.requestedAt || refund.createdAt,
    //   },
    // });
  }

  async sendRefundStatusUpdate(refund: Refund, status: string): Promise<void> {
    // In a real implementation, this would send an email to the customer
    console.log(`[EMAIL] Refund status update for ${refund.id}`, {
      to: `customer-${refund.requestedBy}@example.com`, // Would look up customer email
      subject: `Refund ${status.toUpperCase()} - ${refund.id}`,
      status,
      refundId: refund.id,
      amount: refundAmountOf(refund).toString(),
    });

    // Example integration:
    // const customer = await this.customerService.getById(refund.requestedBy);
    // await this.emailService.send({
    //   to: customer.email,
    //   from: this.emailConfig.fromEmail,
    //   subject: `Refund ${status.toUpperCase()} - ${refund.id}`,
    //   template: 'refund-status-update',
    //   variables: {
    //     customerName: customer.name,
    //     refundId: refund.id,
    //     status,
    //     amount: refund.refundAmount,
    //     completedAt: refund.completedAt,
    //   },
    // });
  }

  async sendRefundFailureAlert(refund: Refund, error: unknown): Promise<void> {
    // In a real implementation, this would send an alert to support team
    console.log(`[EMAIL] Refund failure alert for ${refund.id}`, {
      to: this.emailConfig.supportEmail,
      subject: `URGENT: Refund Processing Failed - ${refund.id}`,
      refundId: refund.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    // Example integration:
    // await this.emailService.send({
    //   to: this.emailConfig.supportEmail,
    //   from: this.emailConfig.fromEmail,
    //   subject: `URGENT: Refund Processing Failed - ${refund.id}`,
    //   template: 'refund-failure-alert',
    //   variables: {
    //     refundId: refund.id,
    //     amount: refund.refundAmount,
    //     error: error instanceof Error ? error.message : 'Unknown error',
    //     failedAt: now(),
    //     customerNote: refund.customerNote,
    //   },
    // });
  }
}

/**
 * Slack-based Notification Service Implementation
 * Alternative implementation for Slack notifications
 */
export type SlackNotificationConfig = {
  webhookUrl: string;
  adminChannel: string;
  supportChannel: string;
  /** Base URL of the admin app; used to build action button links. */
  adminUrl: string;
};

export class SlackNotificationService implements NotificationService {
  constructor(private readonly slackConfig: SlackNotificationConfig) {}

  async sendRefundApprovalRequest(refund: Refund): Promise<void> {
    const message = {
      channel: this.slackConfig.adminChannel,
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
              url: `${this.slackConfig.adminUrl}/refunds/${refund.id}/approve`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject' },
              style: 'danger',
              url: `${this.slackConfig.adminUrl}/refunds/${refund.id}/reject`,
            },
          ],
        },
      ],
    };

    console.log('[SLACK] Refund approval request', message);

    // Example integration:
    // await fetch(this.slackConfig.webhookUrl, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(message),
    // });
  }

  async sendRefundStatusUpdate(refund: Refund, status: string): Promise<void> {
    const emoji = status === 'completed' ? '✅' : status === 'rejected' ? '❌' : '⏳';

    console.log(`[SLACK] Refund status update: ${emoji} Refund ${refund.id} ${status}`);

    // This would typically be sent to a customer notifications channel
    // or directly to the customer via a bot DM
  }

  async sendRefundFailureAlert(refund: Refund, error: unknown): Promise<void> {
    const message = {
      channel: this.slackConfig.supportChannel,
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
    };

    console.log('[SLACK] Refund failure alert', message);

    // Example integration:
    // await fetch(this.slackConfig.webhookUrl, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(message),
    // });
  }
}

/**
 * Multi-channel Notification Service
 * Combines multiple notification channels for comprehensive coverage
 */
export class MultiChannelNotificationService implements NotificationService {
  constructor(private readonly services: NotificationService[]) {}

  async sendRefundApprovalRequest(refund: Refund): Promise<void> {
    await Promise.allSettled(
      this.services.map(service =>
        service.sendRefundApprovalRequest?.(refund)
      )
    );
  }

  async sendRefundStatusUpdate(refund: Refund, status: string): Promise<void> {
    await Promise.allSettled(
      this.services.map(service =>
        service.sendRefundStatusUpdate?.(refund, status)
      )
    );
  }

  async sendRefundFailureAlert(refund: Refund, error: unknown): Promise<void> {
    await Promise.allSettled(
      this.services.map(service =>
        service.sendRefundFailureAlert?.(refund, error)
      )
    );
  }
}

/**
 * Factory function to create notification service based on configuration
 */
export type EmailNotificationConfig = {
  fromEmail: string;
  supportEmail: string;
  adminEmails: string[];
};

export type NotificationServiceConfig = {
  type: 'email' | 'slack' | 'multi';
  email?: EmailNotificationConfig;
  slack?: SlackNotificationConfig;
};

export function createNotificationService(config: NotificationServiceConfig): NotificationService {
  switch (config.type) {
    case 'email': {
      if (!config.email) {
        throw new Error('Email configuration required for email notifications');
      }
      return new EmailNotificationService(config.email);
    }

    case 'slack': {
      if (!config.slack) {
        throw new Error('Slack configuration required for Slack notifications');
      }
      return new SlackNotificationService(config.slack);
    }

    case 'multi': {
      const services: NotificationService[] = [];
      if (config.email) {
        services.push(new EmailNotificationService(config.email));
      }
      if (config.slack) {
        services.push(new SlackNotificationService(config.slack));
      }
      return new MultiChannelNotificationService(services);
    }

    default: {
      throw new Error(`Unsupported notification service type: ${config.type}`);
    }
  }
}

/**
 * Payment Notification Service Module
 *
 * This module provides comprehensive notification capabilities for the payment system,
 * specifically designed to handle refund-related communications.
 *
 * ## Key Features:
 *
 * ### Multiple Channels
 * - **Email**: Traditional email notifications for customers and admins
 * - **Slack**: Real-time team notifications with interactive elements
 * - **Multi-channel**: Combine multiple services for redundancy
 *
 * ### Notification Types
 * - **Approval Requests**: Notify admins when refunds need manual approval
 * - **Status Updates**: Inform customers about refund status changes
 * - **Failure Alerts**: Alert support team about processing failures
 *
 * ### Integration Points
 * - Seamlessly integrates with RefundService for automatic notifications
 * - Configurable notification rules and templates
 * - Support for custom notification channels via interface
 *
 * ## Usage Example:
 *
 * ```typescript
 * import { createNotificationService } from '@/features/payments/notifications';
 *
 * const notificationService = createNotificationService({
 *   type: 'multi',
 *   email: {
 *     fromEmail: 'noreply@example.com',
 *     supportEmail: 'support@example.com',
 *     adminEmails: ['admin@example.com'],
 *   },
 *   slack: {
 *     webhookUrl: process.env.SLACK_WEBHOOK_URL,
 *     adminChannel: '#refund-approvals',
 *     supportChannel: '#support-alerts',
 *   },
 * });
 *
 * // Use with RefundService
 * const refundService = createRefundService(
 *   db,
 *   paymentProvider,
 *   paymentRepository,
 *   notificationService
 * );
 * ```
 *
 * ## Configuration:
 * The service supports environment-based configuration for easy deployment
 * across different environments (development, staging, production).
 */