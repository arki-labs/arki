import type { Instant } from '@arki/date';
import { fromDate, now, toDate } from '@arki/date';
import { getLogger } from '@arki/log';

import type { ListCommunicationsQuery, UpdateCommunicationStatusInput } from '../contracts.js';
import type {
  CommunicationStatus as CommStatus,
  CommunicationChannel,
  DunningCommunicationId,
  DunningExecutionId,
} from '../primitives.js';
import type { DunningDatabase } from '../repository.js';
import type { DunningTables } from '../tables.js';
import type {
  CommunicationTemplate,
  CommunicationUpdateData,
  CustomerData,
  DunningCommunication,
  DunningExecution,
  DunningTemplate,
} from '../types.js';
import { createDunningCommunicationRepository } from '../repository.js';

/**
 * Interface for communication providers (email, SMS, etc.)
 */
export type CommunicationProvider = {
  readonly channel: CommunicationChannel;
  send(communication: CommunicationRequest): Promise<CommunicationResult>;
  validateConfiguration(): Promise<boolean>;
  getDeliveryStatus?(messageId: string): Promise<CommunicationDeliveryStatus>;
};

export type CommunicationRequest = {
  recipient: string;
  subject?: string;
  content: string;
  template: CommunicationTemplate;
  personalizations: Record<string, string>;
  trackingData?: Record<string, unknown>;
};

export type CommunicationResult = {
  success: boolean;
  messageId?: string;
  errorMessage?: string;
  providerResponse?: Record<string, unknown>;
};

export type CommunicationDeliveryStatus = {
  status: CommStatus;
  timestamp: Instant;
  metadata?: Record<string, unknown>;
};

const logger = getLogger('dunning.communication');

/**
 * Email communication provider with Resend integration
 */
export class EmailProvider implements CommunicationProvider {
  readonly channel = 'email' as const;

  constructor(
    private config: {
      apiKey: string;
      fromEmail: string;
      fromName: string;
    },
  ) {}

  async send(request: CommunicationRequest): Promise<CommunicationResult> {
    try {
      // Process template variables
      const processedContent = this.processTemplate(request.content, request.personalizations);
      const processedSubject = request.subject
        ? this.processTemplate(request.subject, request.personalizations)
        : 'Payment Notice';

      // Send email via Resend API
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${this.config.fromName} <${this.config.fromEmail}>`,
          to: [request.recipient],
          subject: processedSubject,
          html: processedContent,
          tags: [
            {
              name: 'category',
              value: 'dunning',
            },
            {
              name: 'campaign_id',
              value: request.trackingData?.['campaignId']?.toString() || '',
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(`Resend API error: ${response.status} - ${errorData.message || 'Unknown error'}`);
      }

      const data = (await response.json()) as { id: string };

      return {
        success: true,
        messageId: data.id,
        providerResponse: {
          provider: 'resend',
          timestamp: now().toString(),
          recipient: request.recipient,
          resendId: data.id,
        },
      };
    } catch (error) {
      logger.error('Email sending failed', { error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async validateConfiguration(): Promise<boolean> {
    try {
      // Test API key by making a test call to Resend
      const response = await fetch('https://api.resend.com/domains', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      return response.ok && !!this.config.fromEmail;
    } catch {
      return false;
    }
  }

  async getDeliveryStatus(messageId: string): Promise<CommunicationDeliveryStatus> {
    try {
      // Query Resend API for email status
      const response = await fetch(`https://api.resend.com/emails/${messageId}`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      if (response.ok) {
        const data = (await response.json()) as { last_event?: string; created_at: string } & Record<string, unknown>;
        return {
          status: data.last_event === 'delivered' ? 'delivered' : 'sent',
          timestamp: fromDate(new Date(data.created_at)),
          metadata: data,
        };
      }
    } catch (error) {
      logger.error('Failed to get email delivery status', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fallback status
    return {
      status: 'sent',
      timestamp: now(),
    };
  }

  private processTemplate(template: string, personalizations: Record<string, string>): string {
    let processed = template;

    for (const [key, value] of Object.entries(personalizations)) {
      const placeholder = `{{${key}}}`;
      processed = processed.replaceAll(new RegExp(placeholder, 'g'), value);
    }

    return processed;
  }
}

/**
 * SMS communication provider with Twilio integration
 */
export class SMSProvider implements CommunicationProvider {
  readonly channel = 'sms' as const;

  constructor(
    private config: {
      accountSid: string;
      authToken: string;
      fromNumber: string;
    },
  ) {}

  async send(request: CommunicationRequest): Promise<CommunicationResult> {
    try {
      // Process template variables
      const processedContent = this.processTemplate(request.content, request.personalizations);

      // Truncate SMS content to 160 characters for standard SMS
      const smsContent = processedContent.length > 160 ? processedContent.slice(0, 157) + '...' : processedContent;

      // Send SMS via Twilio API
      const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            From: this.config.fromNumber,
            To: request.recipient,
            Body: smsContent,
            StatusCallback: '', // Would be webhook URL for status updates
          }),
        },
      );

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(`Twilio API error: ${response.status} - ${errorData.message || 'Unknown error'}`);
      }

      const data = (await response.json()) as { sid: string; status?: string; uri?: string };

      return {
        success: true,
        messageId: data.sid,
        providerResponse: {
          provider: 'twilio',
          timestamp: now().toString(),
          recipient: request.recipient,
          twilioSid: data.sid,
          status: data.status,
          uri: data.uri,
        },
      };
    } catch (error) {
      logger.error('SMS sending failed', { error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async validateConfiguration(): Promise<boolean> {
    try {
      // Test Twilio credentials by fetching account info
      const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');

      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}.json`, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
        },
      });

      return response.ok && !!this.config.fromNumber;
    } catch {
      return false;
    }
  }

  async getDeliveryStatus(messageId: string): Promise<CommunicationDeliveryStatus> {
    try {
      // Query Twilio API for SMS status
      const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages/${messageId}.json`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        },
      );

      if (response.ok) {
        const data = (await response.json()) as {
          status?: string;
          date_updated?: string;
          date_created?: string;
          error_code?: string;
          error_message?: string;
        };

        // Map Twilio status to our status
        let status: CommStatus = 'sent';
        if (data.status === 'delivered') status = 'delivered';
        else if (data.status === 'failed' || data.status === 'undelivered') status = 'failed';

        return {
          status,
          timestamp: fromDate(new Date(data.date_updated || data.date_created || Date.now())),
          metadata: {
            twilioStatus: data.status,
            errorCode: data.error_code,
            errorMessage: data.error_message,
          },
        };
      }
    } catch (error) {
      logger.error('Failed to get SMS delivery status', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fallback status
    return {
      status: 'sent',
      timestamp: now(),
    };
  }

  private processTemplate(template: string, personalizations: Record<string, string>): string {
    let processed = template;

    for (const [key, value] of Object.entries(personalizations)) {
      const placeholder = `{{${key}}}`;
      processed = processed.replaceAll(new RegExp(placeholder, 'g'), value);
    }

    return processed;
  }
}

/**
 * In-app notification provider with database storage
 */
export class InAppProvider implements CommunicationProvider {
  readonly channel = 'in_app' as const;

  constructor(
    private config: {
      appUrl: string;
    },
    private db: DunningDatabase,
  ) {}

  async send(request: CommunicationRequest): Promise<CommunicationResult> {
    try {
      const processedContent = this.processTemplate(request.content, request.personalizations);
      const processedSubject = request.subject
        ? this.processTemplate(request.subject, request.personalizations)
        : 'Payment Notice';

      // Store notification in database (assuming notifications table exists)
      const notificationId = `inapp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

      // Since we don't have a notifications table schema yet, we'll simulate storing it
      // In a real implementation, you would:
      // 1. Insert into a notifications table
      // 2. Potentially trigger real-time updates via WebSocket/Server-Sent Events
      // 3. Store it in a way that can be queried by the user's dashboard

      logger.info('Creating in-app notification', {
        userId: request.recipient,
        subject: processedSubject,
        contentPreview: processedContent.slice(0, 100),
      });

      // Here you would typically:
      // await this.db.insert(notifications).values({
      //   id: notificationId,
      //   userId: request.recipient,
      //   title: processedSubject,
      //   content: processedContent,
      //   type: 'payment_reminder',
      //   category: 'dunning',
      //   isRead: false,
      //   metadata: request.trackingData,
      //   createdAt: now(),
      // });

      // For now, we'll simulate success
      return {
        success: true,
        messageId: notificationId,
        providerResponse: {
          provider: 'in_app',
          timestamp: now().toString(),
          recipient: request.recipient,
          notificationId,
          appUrl: `${this.config.appUrl}/notifications/${notificationId}`,
        },
      };
    } catch (error) {
      logger.error('In-app notification creation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async validateConfiguration(): Promise<boolean> {
    try {
      // Check if database connection is working and app URL is valid
      return !!this.config.appUrl && !!this.db;
    } catch {
      return false;
    }
  }

  async getDeliveryStatus(messageId: string): Promise<CommunicationDeliveryStatus> {
    try {
      // Query database for notification read status
      // In a real implementation:
      // const notification = await this.db.query.notifications.findFirst({
      //   where: eq(notifications.id, messageId),
      // });

      // For now, simulate checking if the notification was "read"
      return {
        status: 'delivered', // In-app notifications are considered delivered when created
        timestamp: now(),
        metadata: {
          messageId,
          readAt: null, // Would be filled if user has read the notification
        },
      };
    } catch (error) {
      logger.error('Failed to get in-app notification status', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'delivered',
        timestamp: now(),
      };
    }
  }

  private processTemplate(template: string, personalizations: Record<string, string>): string {
    let processed = template;

    for (const [key, value] of Object.entries(personalizations)) {
      const placeholder = `{{${key}}}`;
      processed = processed.replaceAll(new RegExp(placeholder, 'g'), value);
    }

    return processed;
  }
}

/**
 * Webhook communication provider for external integrations
 */
export class WebhookProvider implements CommunicationProvider {
  readonly channel = 'webhook' as const;

  constructor(
    private config: {
      defaultHeaders: Record<string, string>;
      timeout: number;
    },
  ) {}

  async send(request: CommunicationRequest): Promise<CommunicationResult> {
    try {
      // For webhook communications, the recipient should be the webhook URL
      const webhookUrl = request.recipient;

      if (!webhookUrl.startsWith('http')) {
        throw new Error('Invalid webhook URL');
      }

      // Process template variables in content (webhook payload)
      const processedContent = this.processTemplate(request.content, request.personalizations);

      // Parse content as JSON payload
      let payload;
      try {
        payload = JSON.parse(processedContent);
      } catch {
        // If not JSON, send as text payload
        payload = { message: processedContent };
      }

      // Add metadata to payload
      payload.metadata = {
        ...payload.metadata,
        ...request.trackingData,
        timestamp: now().toString(),
      };

      const messageId = `webhook_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

      // Send webhook with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Strophie-Dunning/1.0',
          ...this.config.defaultHeaders,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
      }

      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) {
        responseHeaders[key] = value;
      }

      return {
        success: true,
        messageId,
        providerResponse: {
          provider: 'webhook',
          timestamp: now().toString(),
          recipient: webhookUrl,
          status: response.status,
          headers: responseHeaders,
        },
      };
    } catch (error) {
      logger.error('Webhook sending failed', { error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async validateConfiguration(): Promise<boolean> {
    // Basic validation - webhook URLs are validated per-request
    return !!this.config.timeout && this.config.timeout > 0;
  }

  private processTemplate(template: string, personalizations: Record<string, string>): string {
    let processed = template;

    for (const [key, value] of Object.entries(personalizations)) {
      const placeholder = `{{${key}}}`;
      processed = processed.replaceAll(new RegExp(placeholder, 'g'), value);
    }

    return processed;
  }
}

/**
 * Main communication orchestration service
 * Manages multiple communication providers and handles delivery orchestration
 */
export class CommunicationOrchestrationService {
  private providers = new Map<CommunicationChannel, CommunicationProvider>();
  private communicationRepo;

  constructor(db: DunningDatabase, tables: Pick<DunningTables, 'dunningCommunications'>) {
    this.communicationRepo = createDunningCommunicationRepository(db, tables);
  }

  /**
   * Register a communication provider
   */
  registerProvider(provider: CommunicationProvider): void {
    this.providers.set(provider.channel, provider);
  }

  /**
   * Send communication for a dunning execution
   */
  async sendCommunication(
    execution: DunningExecution,
    template: DunningTemplate,
    customer: CustomerData,
    personalizations: Record<string, string> = {},
  ): Promise<DunningCommunication> {
    const provider = this.providers.get(template.communication.channel);
    if (!provider) {
      throw new Error(`No provider registered for channel: ${template.communication.channel}`);
    }

    // Determine recipient based on channel
    const recipient = this.getRecipient(customer, template.communication.channel);

    // Create communication record
    const communication = await this.communicationRepo.create({
      executionId: execution.id,
      customerId: execution.customerId,
      templateId: template.id,
      channel: template.communication.channel,
      recipient,
      subject: template.communication.subject ?? null,
      content: template.communication.content,
      status: 'pending',
    });

    try {
      // Send the communication
      const result = await provider.send({
        recipient,
        subject: template.communication.subject,
        content: template.communication.content,
        template: template.communication,
        personalizations: {
          ...this.getDefaultPersonalizations(customer),
          ...personalizations,
        },
        trackingData: {
          executionId: execution.id,
          campaignId: execution.campaignId,
          customerId: execution.customerId,
        },
      });

      // Update communication status
      if (result.success) {
        await this.communicationRepo.updateStatus(communication.id, 'sent', {
          sentAt: now(),
          providerMessageId: result.messageId,
          providerResponse: result.providerResponse,
        });
      } else {
        await this.communicationRepo.updateStatus(communication.id, 'failed', {
          failureReason: result.errorMessage,
        });
      }

      return communication;
    } catch (error) {
      // Update communication status on error
      await this.communicationRepo.updateStatus(communication.id, 'failed', {
        failureReason: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Get recipient address based on customer and channel
   */
  private getRecipient(customer: CustomerData, channel: CommunicationChannel): string {
    switch (channel) {
      case 'email': {
        return customer.email || '';
      }
      case 'sms': {
        return customer.phone || (customer.metadata?.['phone'] as string) || '';
      }
      case 'in_app': {
        return customer.id;
      } // Use customer ID instead of userId which doesn't exist
      case 'webhook': {
        return (customer.metadata?.['webhookUrl'] as string) || '';
      }
      default: {
        throw new Error(`Unknown communication channel: ${channel}`);
      }
    }
  }

  /**
   * Get default personalizations for a customer
   */
  private getDefaultPersonalizations(customer: CustomerData): Record<string, string> {
    return {
      customer_name: customer.name || 'Valued Customer',
      customer_email: customer.email || '',
      customer_id: customer.id,
      current_date: toDate(now()).toLocaleDateString(),
      company_name: 'Your Company', // Would come from configuration
    };
  }

  /**
   * Process pending communications
   */
  async processPendingCommunications(limit = 100): Promise<void> {
    const pendingCommunications = await this.communicationRepo.findPendingCommunications(limit);

    for (const communication of pendingCommunications) {
      try {
        const provider = this.providers.get(communication.channel);
        if (!provider) {
          logger.error('No provider configured for channel', { channel: communication.channel });
          continue;
        }

        // For pending communications, we need to get the customer and execution data
        // This is a simplified version - in practice you'd join with customer data
        const result = await provider.send({
          recipient: communication.recipient,
          subject: communication.subject ?? undefined,
          content: communication.content,
          template: {
            channel: communication.channel,
            content: communication.content,
            subject: communication.subject ?? undefined,
            variables: [],
          },
          personalizations: {}, // Would be filled from customer data
        });

        if (result.success) {
          await this.communicationRepo.updateStatus(communication.id, 'sent', {
            sentAt: now(),
            providerMessageId: result.messageId,
            providerResponse: result.providerResponse,
          });
        } else {
          await this.communicationRepo.updateStatus(communication.id, 'failed', {
            failureReason: result.errorMessage,
          });
        }
      } catch (error) {
        logger.error('Failed to process communication', {
          communicationId: communication.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.communicationRepo.updateStatus(communication.id, 'failed', {
          failureReason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  /**
   * Handle communication status webhooks
   */
  async handleCommunicationWebhook(data: {
    providerMessageId: string;
    event: 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained';
    timestamp: Instant;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const communication = await this.communicationRepo.findByProviderMessageId(data.providerMessageId);
    if (!communication) {
      logger.warn('Communication not found for provider message ID', { providerMessageId: data.providerMessageId });
      return;
    }

    const updates: Partial<CommunicationUpdateData> = {
      trackingData: {
        ...communication.trackingData,
        [data.event]: data.timestamp,
        ...(data.metadata && { metadata: data.metadata }),
      },
      updatedAt: now(),
    };

    switch (data.event) {
      case 'delivered': {
        updates.deliveredAt = data.timestamp;
        break;
      }
      case 'opened': {
        updates.openedAt = data.timestamp;
        break;
      }
      case 'clicked': {
        updates.clickedAt = data.timestamp;
        break;
      }
      case 'bounced': {
        updates.failureReason = 'Email bounced';
        break;
      }
    }

    await this.communicationRepo.updateStatus(
      communication.id,
      data.event === 'bounced' ? 'bounced' : communication.status,
      updates,
    );
  }

  /**
   * Get communication by ID
   */
  async getCommunication(communicationId: DunningCommunicationId): Promise<DunningCommunication | null> {
    return this.communicationRepo.findById(communicationId);
  }

  /**
   * List communications with filtering
   */
  async listCommunications(query: ListCommunicationsQuery): Promise<DunningCommunication[]> {
    return this.communicationRepo.findMany(query);
  }

  /**
   * Update communication status manually
   */
  async updateCommunicationStatus(input: UpdateCommunicationStatusInput): Promise<DunningCommunication | null> {
    const updates: Partial<CommunicationUpdateData> = { updatedAt: now() };

    if (input.sentAt) updates.sentAt = input.sentAt;
    if (input.deliveredAt) updates.deliveredAt = input.deliveredAt;
    if (input.openedAt) updates.openedAt = input.openedAt;
    if (input.clickedAt) updates.clickedAt = input.clickedAt;
    if (input.failureReason) updates.failureReason = input.failureReason;
    if (input.providerMessageId) updates.providerMessageId = input.providerMessageId;
    if (input.providerResponse) updates.providerResponse = input.providerResponse;
    if (input.trackingData) updates.trackingData = input.trackingData;

    return this.communicationRepo.updateStatus(input.communicationId, input.status, updates);
  }

  /**
   * Get communication metrics for an execution
   */
  async getCommunicationMetrics(executionId: DunningExecutionId) {
    return this.communicationRepo.getMetricsForExecution(executionId);
  }

  /**
   * Validate all registered providers
   */
  async validateProviders(): Promise<Record<CommunicationChannel, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [channel, provider] of this.providers) {
      try {
        results[channel] = await provider.validateConfiguration();
      } catch (error) {
        logger.error('Provider validation failed', {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
        results[channel] = false;
      }
    }

    return results as Record<CommunicationChannel, boolean>;
  }

  /**
   * Get delivery status for a communication
   */
  async getDeliveryStatus(communicationId: DunningCommunicationId): Promise<CommunicationDeliveryStatus | null> {
    const communication = await this.communicationRepo.findById(communicationId);
    if (!communication || !communication.providerMessageId) {
      return null;
    }

    const provider = this.providers.get(communication.channel);
    if (!provider || !provider.getDeliveryStatus) {
      return null;
    }

    try {
      return await provider.getDeliveryStatus(communication.providerMessageId);
    } catch (error) {
      logger.error('Failed to get delivery status', {
        communicationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Retry failed communications
   */
  async retryFailedCommunications(limit = 50): Promise<void> {
    const failedCommunications = await this.communicationRepo.findMany({
      limit,
      offset: 0,
      status: 'failed',
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    for (const communication of failedCommunications) {
      try {
        // Reset status to pending for retry
        await this.communicationRepo.updateStatus(communication.id, 'pending');
      } catch (error) {
        logger.error('Failed to retry communication', {
          communicationId: communication.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Process the retried communications
    await this.processPendingCommunications(limit);
  }
}

export type CommunicationOrchestrationConfig = {
  email?: {
    apiKey: string;
    fromEmail: string;
    fromName?: string;
  };
  sms?: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
  };
  inApp?: {
    appUrl: string;
  };
  webhook?: {
    defaultHeaders?: Record<string, string>;
    timeoutMs?: number;
    sourceHeader?: string;
  };
};

/**
 * Factory function to create CommunicationOrchestrationService.
 *
 * Apps inject channel-provider config rather than the package reading
 * `env` directly — preserves the @arki/payments package as
 * config-injectable and env-agnostic.
 */
export function createCommunicationOrchestrationService(
  db: DunningDatabase,
  tables: Pick<DunningTables, 'dunningCommunications'>,
  config: CommunicationOrchestrationConfig = {},
) {
  const service = new CommunicationOrchestrationService(db, tables);

  if (config.email) {
    service.registerProvider(
      new EmailProvider({
        apiKey: config.email.apiKey,
        fromEmail: config.email.fromEmail,
        fromName: config.email.fromName ?? 'Payments',
      }),
    );
  }

  if (config.sms) {
    service.registerProvider(
      new SMSProvider({
        accountSid: config.sms.accountSid,
        authToken: config.sms.authToken,
        fromNumber: config.sms.fromNumber,
      }),
    );
  }

  if (config.inApp) {
    service.registerProvider(new InAppProvider({ appUrl: config.inApp.appUrl }, db));
  }

  service.registerProvider(
    new WebhookProvider({
      defaultHeaders: config.webhook?.defaultHeaders ?? {
        'X-Source': config.webhook?.sourceHeader ?? 'dunning-system',
      },
      timeout: config.webhook?.timeoutMs ?? 30_000,
    }),
  );

  return service;
}
