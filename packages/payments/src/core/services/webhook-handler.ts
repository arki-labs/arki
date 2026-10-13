import { EventEmitter } from 'node:events';

import { now } from '@arki/date';

import type { PaymentRepository } from '../repository.js';
import type { PaymentProviderType, WebhookEventType, WebhookId } from '../types.js';
import type { WebhookSecurityService } from './webhook-security.js';
import { createWebhookId } from '../primitives.js';

export type WebhookProcessingResult = {
  success: boolean;
  webhookId?: WebhookId;
  error?: string;
  retryable?: boolean;
}

export type WebhookEventData = {
  type: WebhookEventType;
  provider: PaymentProviderType;
  data: Record<string, unknown>;
  webhookId: WebhookId;
}

export type WebhookHandlerConfig = {
  maxRetries: number;
  retryDelayMs: number;
  enableAsync: boolean;
  enableEventEmitter: boolean;
}

export class WebhookHandler extends EventEmitter {
  private readonly config: WebhookHandlerConfig;
  private readonly eventHandlers = new Map<WebhookEventType, (data: WebhookEventData) => Promise<void>>();

  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly webhookSecurity: WebhookSecurityService,
    config: Partial<WebhookHandlerConfig> = {},
  ) {
    super();
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      enableAsync: true,
      enableEventEmitter: true,
      ...config,
    };

    this.setupEventHandlers();
  }

  async processWebhook(
    provider: PaymentProviderType,
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    sourceIp: string,
    webhookSecret: string,
  ): Promise<WebhookProcessingResult> {
    try {
      // 1. Validate webhook security
      const validation = await this.webhookSecurity.validateWebhook(
        provider,
        payload,
        signature,
        timestamp,
        sourceIp,
        webhookSecret,
      );

      if (!validation.isValid) {
        return {
          success: false,
          error: validation.error || 'Webhook validation failed',
          retryable: false,
        };
      }

      // 2. Parse event data
      const eventData = this.parseEventData(payload);
      if (!eventData.type || !eventData.id) {
        return {
          success: false,
          error: 'Invalid webhook payload: missing type or id',
          retryable: false,
        };
      }

      // 3. Check for duplicate events
      const existingEvent = await this.paymentRepository.findWebhookEventByProviderEventId(eventData.id, provider);
      if (existingEvent?.processed) {
        return {
          success: true,
          webhookId: existingEvent.id,
          error: 'Event already processed',
        };
      }

      // 4. Store webhook event
      let webhookId: WebhookId;
      if (existingEvent) {
        webhookId = existingEvent.id;
        await this.paymentRepository.incrementWebhookEventAttempts(webhookId);
      } else {
        const webhookEvent = await this.paymentRepository.createWebhookEvent({
          id: createWebhookId(),
          provider,
          eventType: validation.eventType!,
          providerEventId: eventData.id,
          data: validation.data || {},
          processed: false,
          attempts: 1,
          lastAttemptAt: now(),
          sourceIp,
          createdAt: now(),
          updatedAt: now(),
        });
        webhookId = webhookEvent.id;
      }

      // 5. Process the event
      if (this.config.enableAsync) {
        // Process asynchronously
        this.processEventAsync(webhookId, validation.eventType!, provider, validation.data || {});
        return { success: true, webhookId };
      } else {
        // Process synchronously
        await this.processEvent(webhookId, validation.eventType!, provider, validation.data || {});
        return { success: true, webhookId };
      }
    } catch (error) {
      return {
        success: false,
        error: `Webhook processing error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        retryable: true,
      };
    }
  }

  async retryFailedWebhooks(): Promise<void> {
    try {
      const unprocessedEvents = await this.paymentRepository.findUnprocessedWebhookEvents();

      for (const event of unprocessedEvents) {
        if (event.attempts < this.config.maxRetries) {
          await this.processEventAsync(event.id, event.eventType, event.provider, event.data);
        } else {
          // Mark as failed after max retries
          await this.paymentRepository.updateWebhookEvent(event.id, {
            errorMessage: 'Max retry attempts exceeded',
          });

          this.emit('webhook:failed', {
            webhookId: event.id,
            eventType: event.eventType,
            provider: event.provider,
            error: 'Max retry attempts exceeded',
          });
        }
      }
    } catch (error) {
      this.emit('webhook:retry_error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async processEventAsync(
    webhookId: WebhookId,
    eventType: WebhookEventType,
    provider: PaymentProviderType,
    data: Record<string, unknown>,
  ): Promise<void> {
    // Process in background
    setImmediate(async () => {
      try {
        await this.processEvent(webhookId, eventType, provider, data);
      } catch (error) {
        await this.paymentRepository.incrementWebhookEventAttempts(
          webhookId,
          error instanceof Error ? error.message : 'Unknown error',
        );

        this.emit('webhook:processing_error', {
          webhookId,
          eventType,
          provider,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  private async processEvent(
    webhookId: WebhookId,
    eventType: WebhookEventType,
    provider: PaymentProviderType,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      const eventData: WebhookEventData = {
        type: eventType,
        provider,
        data,
        webhookId,
      };

      // Execute specific event handler
      const handler = this.eventHandlers.get(eventType);
      if (handler) {
        await handler(eventData);
      } else {
        console.warn(`No handler found for webhook event type: ${eventType}`);
      }

      // Mark as processed
      await this.paymentRepository.markWebhookEventAsProcessed(webhookId);

      // Emit success event
      if (this.config.enableEventEmitter) {
        this.emit('webhook:processed', eventData);
        this.emit(`webhook:${eventType}`, eventData);
      }
    } catch (error) {
      throw error;
    }
  }

  private parseEventData(payload: string | Buffer): { type: string; id: string; data: Record<string, unknown> } {
    try {
      const payloadStr = typeof payload === 'string' ? payload : payload.toString();
      return JSON.parse(payloadStr);
    } catch {
      return { type: '', id: '', data: {} };
    }
  }

  private setupEventHandlers(): void {
    // Subscription events
    this.eventHandlers.set('subscription.created', async (data: WebhookEventData) => {
      await this.handleSubscriptionCreated(data);
    });

    this.eventHandlers.set('subscription.updated', async (data: WebhookEventData) => {
      await this.handleSubscriptionUpdated(data);
    });

    this.eventHandlers.set('subscription.canceled', async (data: WebhookEventData) => {
      await this.handleSubscriptionCanceled(data);
    });

    this.eventHandlers.set('subscription.trial_will_end', async (data: WebhookEventData) => {
      await this.handleSubscriptionTrialWillEnd(data);
    });

    // Payment events
    this.eventHandlers.set('payment.succeeded', async (data: WebhookEventData) => {
      await this.handlePaymentSucceeded(data);
    });

    this.eventHandlers.set('payment.failed', async (data: WebhookEventData) => {
      await this.handlePaymentFailed(data);
    });

    this.eventHandlers.set('payment.requires_action', async (data: WebhookEventData) => {
      await this.handlePaymentRequiresAction(data);
    });

    // Customer events
    this.eventHandlers.set('customer.created', async (data: WebhookEventData) => {
      await this.handleCustomerCreated(data);
    });

    this.eventHandlers.set('customer.updated', async (data: WebhookEventData) => {
      await this.handleCustomerUpdated(data);
    });

    this.eventHandlers.set('customer.deleted', async (data: WebhookEventData) => {
      await this.handleCustomerDeleted(data);
    });

    // Invoice events
    this.eventHandlers.set('invoice.created', async (data: WebhookEventData) => {
      await this.handleInvoiceCreated(data);
    });

    this.eventHandlers.set('invoice.finalized', async (data: WebhookEventData) => {
      await this.handleInvoiceFinalized(data);
    });

    this.eventHandlers.set('invoice.paid', async (data: WebhookEventData) => {
      await this.handleInvoicePaid(data);
    });

    this.eventHandlers.set('invoice.payment_failed', async (data: WebhookEventData) => {
      await this.handleInvoicePaymentFailed(data);
    });
  }

  // Event handler implementations
  private async handleSubscriptionCreated(data: WebhookEventData): Promise<void> {
    try {
      // Extract subscription data from webhook
      const subscriptionData = data.data;
      console.log('Subscription created:', subscriptionData);

      // Update local database if needed
      // This would typically sync with the provider data

      this.emit('subscription:created', { subscriptionData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle subscription created: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSubscriptionUpdated(data: WebhookEventData): Promise<void> {
    try {
      const subscriptionData = data.data;
      console.log('Subscription updated:', subscriptionData);

      // Sync subscription status and details with local database

      this.emit('subscription:updated', { subscriptionData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle subscription updated: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSubscriptionCanceled(data: WebhookEventData): Promise<void> {
    try {
      const subscriptionData = data.data;
      console.log('Subscription canceled:', subscriptionData);

      // Update subscription status in local database
      // Trigger any cancellation workflows (access revocation, notifications, etc.)

      this.emit('subscription:canceled', { subscriptionData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle subscription canceled: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSubscriptionTrialWillEnd(data: WebhookEventData): Promise<void> {
    try {
      const subscriptionData = data.data;
      console.log('Subscription trial will end:', subscriptionData);

      // Send trial ending notifications
      // Update user about upcoming charges

      this.emit('subscription:trial_ending', { subscriptionData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle trial will end: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handlePaymentSucceeded(data: WebhookEventData): Promise<void> {
    try {
      const paymentData = data.data;
      console.log('Payment succeeded:', paymentData);

      // Update payment status in local database
      // Send payment confirmation
      // Update user access/features

      this.emit('payment:succeeded', { paymentData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle payment succeeded: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handlePaymentFailed(data: WebhookEventData): Promise<void> {
    try {
      const paymentData = data.data;
      console.log('Payment failed:', paymentData);

      // Update payment status in local database
      // Send payment failure notification
      // Implement retry logic or access restrictions

      this.emit('payment:failed', { paymentData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle payment failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handlePaymentRequiresAction(data: WebhookEventData): Promise<void> {
    try {
      const paymentData = data.data;
      console.log('Payment requires action:', paymentData);

      // Notify user that action is required (e.g., 3D Secure authentication)

      this.emit('payment:requires_action', { paymentData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle payment requires action: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleCustomerCreated(data: WebhookEventData): Promise<void> {
    try {
      const customerData = data.data;
      console.log('Customer created:', customerData);

      this.emit('customer:created', { customerData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle customer created: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleCustomerUpdated(data: WebhookEventData): Promise<void> {
    try {
      const customerData = data.data;
      console.log('Customer updated:', customerData);

      this.emit('customer:updated', { customerData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle customer updated: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleCustomerDeleted(data: WebhookEventData): Promise<void> {
    try {
      const customerData = data.data;
      console.log('Customer deleted:', customerData);

      // Clean up customer data and subscriptions

      this.emit('customer:deleted', { customerData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle customer deleted: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleInvoiceCreated(data: WebhookEventData): Promise<void> {
    try {
      const invoiceData = data.data;
      console.log('Invoice created:', invoiceData);

      this.emit('invoice:created', { invoiceData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle invoice created: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleInvoiceFinalized(data: WebhookEventData): Promise<void> {
    try {
      const invoiceData = data.data;
      console.log('Invoice finalized:', invoiceData);

      this.emit('invoice:finalized', { invoiceData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle invoice finalized: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleInvoicePaid(data: WebhookEventData): Promise<void> {
    try {
      const invoiceData = data.data;
      console.log('Invoice paid:', invoiceData);

      this.emit('invoice:paid', { invoiceData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle invoice paid: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleInvoicePaymentFailed(data: WebhookEventData): Promise<void> {
    try {
      const invoiceData = data.data;
      console.log('Invoice payment failed:', invoiceData);

      this.emit('invoice:payment_failed', { invoiceData, webhookId: data.webhookId });
    } catch (error) {
      throw new Error(`Failed to handle invoice payment failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Public utility methods
  public registerEventHandler(eventType: WebhookEventType, handler: (data: WebhookEventData) => Promise<void>): void {
    this.eventHandlers.set(eventType, handler);
  }

  public removeEventHandler(eventType: WebhookEventType): void {
    this.eventHandlers.delete(eventType);
  }

  public getProcessingStats(): {
    totalHandlers: number;
    supportedEventTypes: WebhookEventType[];
  } {
    return {
      totalHandlers: this.eventHandlers.size,
      supportedEventTypes: [...this.eventHandlers.keys()],
    };
  }
}

export function createWebhookHandler(
  paymentRepository: PaymentRepository,
  webhookSecurity: WebhookSecurityService,
  config?: Partial<WebhookHandlerConfig>,
) {
  return new WebhookHandler(paymentRepository, webhookSecurity, config);
}