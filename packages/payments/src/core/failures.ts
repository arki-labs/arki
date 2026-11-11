/**
 * The expected ways a subscription change, a proration, a retry schedule, a repository write or a
 * notification is refused, each defined once. The services and the repository return them; they
 * never throw them. A missing customer, plan, payment or subscription row is `ReferenceNotFound`
 * from `./providers/provider-error.js`.
 */
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

/** What a caller asked a subscription to do, in `SubscriptionInvalidState`. */
const subscriptionActionSchema = z.enum([
  'update',
  'cancel',
  'set_cancel_at_period_end',
  'reactivate',
  'pause',
  'resume',
]);

/**
 * The subscription's status does not allow the change: an update or a pause needs `active`, a
 * resume needs `paused`, a reactivation needs `canceled` or `past_due`, and a canceled
 * subscription cannot be canceled or flagged again. Nothing was sent to the provider or written.
 *
 * @fix Read the subscription again and ask only for a change its status allows.
 * @verify bun run test -- src/core/services/subscription-manager.test.ts
 */
export const SubscriptionInvalidState = /* @__PURE__ */ defineFailure('payments.subscription_invalid_state', {
  status: 409,
  data: z.object({ subscriptionId: z.string(), status: z.string(), action: subscriptionActionSchema }),
  message: ({ subscriptionId, status, action }) =>
    `Subscription ${subscriptionId} is ${status}, so it cannot ${action.replaceAll('_', ' ')}`,
  remediation: 'Read the subscription again and ask only for a change its status allows.',
});

/**
 * The user already has an active subscription, so a second one is not created. Nothing was sent to
 * the provider or written.
 *
 * @fix Change the plan of the existing subscription instead (`updateSubscription`).
 * @verify bun run test -- src/core/services/subscription-manager.test.ts
 */
export const SubscriptionAlreadyActive = /* @__PURE__ */ defineFailure('payments.subscription_already_active', {
  status: 409,
  data: z.object({ userId: z.string(), subscriptionId: z.string() }),
  message: 'User {userId} already has the active subscription {subscriptionId}',
  remediation: 'Change the plan of the existing subscription instead.',
});

/**
 * The plan exists but is no longer offered (`isActive` is false). Nothing was sent to the provider or written.
 *
 * @fix Pick an active plan (`findActivePlans`).
 * @verify bun run test -- src/core/services/subscription-manager.test.ts
 */
export const PlanInactive = /* @__PURE__ */ defineFailure('payments.plan_inactive', {
  status: 409,
  data: z.object({ planId: z.string() }),
  message: 'Plan {planId} is not active',
  remediation: 'Pick an active plan.',
});

/**
 * The two plans of a plan change are priced in different currencies, so a credit on one cannot be
 * set against a charge on the other.
 *
 * @fix Move the subscription to a plan in the same currency, or cancel it and start a new one.
 * @verify bun run test -- src/core/services/proration-service.test.ts
 */
export const PlanCurrencyMismatch = /* @__PURE__ */ defineFailure('payments.plan_currency_mismatch', {
  status: 422,
  data: z.object({
    currentPlanId: z.string(),
    newPlanId: z.string(),
    currentCurrency: z.string(),
    newCurrency: z.string(),
  }),
  message: 'Plan {currentPlanId} is in {currentCurrency} but plan {newPlanId} is in {newCurrency}',
  remediation: 'Move the subscription to a plan in the same currency, or cancel it and start a new one.',
});

/**
 * A plan change was asked to take effect outside the subscription's current period. Times are ISO
 * instants.
 *
 * @fix Pick an effective date between `periodStart` and `periodEnd`, or leave it out to mean now.
 * @verify bun run test -- src/core/services/proration-service.test.ts
 */
export const EffectiveDateOutsidePeriod = /* @__PURE__ */ defineFailure('payments.effective_date_outside_period', {
  status: 422,
  data: z.object({
    subscriptionId: z.string(),
    effectiveDate: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
  }),
  message:
    'Effective date {effectiveDate} is outside the period {periodStart} to {periodEnd} of subscription {subscriptionId}',
  remediation: 'Pick an effective date inside the current period, or leave it out to mean now.',
});

/**
 * The payment belongs to no subscription, so there is no subscription to keep alive with retries.
 * Nothing was scheduled.
 *
 * @fix Retry a one-off payment by asking the customer to pay again.
 * @verify bun run test -- src/core/services/payment-retry-service.test.ts
 */
export const PaymentWithoutSubscription = /* @__PURE__ */ defineFailure('payments.payment_without_subscription', {
  status: 422,
  data: z.object({ paymentId: z.string() }),
  message: 'Payment {paymentId} belongs to no subscription',
  remediation: 'Retry a one-off payment by asking the customer to pay again.',
});

/**
 * A new customer clashes with a stored one: the user already has a customer with another provider
 * id (`existingCustomerId` is that customer), or the provider id belongs to another user's customer
 * (`existingCustomerId` is null). Nothing was written.
 *
 * @fix Use the user's stored customer (`findCustomerByUserId`), or check which user the provider customer belongs to.
 * @verify bun run test -- src/core/repository.customers.test.ts
 */
export const CustomerConflict = /* @__PURE__ */ defineFailure('payments.customer_conflict', {
  status: 409,
  data: z.object({ userId: z.string(), providerCustomerId: z.string(), existingCustomerId: z.string().nullable() }),
  message: ({ userId, providerCustomerId, existingCustomerId }) =>
    existingCustomerId === null
      ? `Provider customer ${providerCustomerId} already belongs to another user than ${userId}`
      : `User ${userId} already has customer ${existingCustomerId} with another provider customer`,
  remediation: "Use the user's stored customer, or check which user the provider customer belongs to.",
});

/**
 * No webhook event has this id. Nothing was written.
 *
 * @fix Check the webhook event id. Ids come from `claimWebhookEvent` or `findWebhookEventByProviderEventId`.
 * @verify bun run test -- src/core/repository.customers.test.ts
 */
export const WebhookEventNotFound = /* @__PURE__ */ defineFailure('payments.webhook_event_not_found', {
  status: 404,
  data: z.object({ webhookId: z.string() }),
  message: 'Webhook event {webhookId} not found',
  remediation: 'Check the webhook event id.',
});

/**
 * The retry service has no strategy with this name, so `updateRetryStrategy` changed nothing.
 *
 * @fix Check the name against `getRetryStrategies()`, or add the strategy first with `addRetryStrategy`.
 * @verify bun run test -- src/core/services/payment-retry-service.test.ts
 */
export const RetryStrategyNotFound = /* @__PURE__ */ defineFailure('payments.retry_strategy_not_found', {
  status: 404,
  data: z.object({ name: z.string() }),
  message: 'Retry strategy {name} not found',
  remediation: 'Check the name against the retry service strategies, or add the strategy first.',
});

/**
 * A plan with this id is already stored, so `createPlan` wrote nothing.
 *
 * @fix Update the stored plan (`updatePlan`), or leave `id` out so a new one is made.
 * @verify bun run test -- src/core/repository.customers.test.ts
 */
export const PlanAlreadyExists = /* @__PURE__ */ defineFailure('payments.plan_already_exists', {
  status: 409,
  data: z.object({ planId: z.string() }),
  message: 'Plan {planId} already exists',
  remediation: 'Update the stored plan, or leave the id out so a new one is made.',
});

/**
 * The customer cannot be deleted: a row that may not go with it (a refund of one of its payments,
 * or an app row) still points at it or at one of its payments. Nothing was deleted.
 *
 * @fix Keep the customer, or remove what points at it first.
 * @verify bun run test -- src/core/repository.customers.test.ts
 */
export const CustomerInUse = /* @__PURE__ */ defineFailure('payments.customer_in_use', {
  status: 409,
  data: z.object({ customerId: z.string() }),
  message: 'Customer {customerId} cannot be deleted: other rows still point at it or at its payments',
  remediation: 'Keep the customer, or remove what points at it first.',
});

/**
 * Another webhook event already holds this provider event id (or this webhook id). Nothing was written.
 *
 * @fix Read the stored event (`findWebhookEventByProviderEventId`); a delivery handler claims events with `claimWebhookEvent`.
 * @verify bun run test -- src/core/repository.customers.test.ts
 */
export const WebhookEventExists = /* @__PURE__ */ defineFailure('payments.webhook_event_exists', {
  status: 409,
  data: z.object({ providerEventId: z.string() }),
  message: 'A webhook event already holds provider event {providerEventId}',
  remediation: 'Read the stored event; claim deliveries with claimWebhookEvent.',
});

/** Which notification did not go out, in `NotificationFailed`. */
const notificationKindSchema = z.enum(['refund_approval_request', 'refund_status_update', 'refund_failure_alert']);

/**
 * A notification was not delivered: the mail transport returned a failure (the `cause`), the Slack
 * webhook answered with a non-2xx `status`, or the request failed or timed out (the `cause`).
 *
 * @fix Check the transport or the Slack webhook URL and its status page, then send the notification again.
 * @verify bun run test -- src/core/notifications/service.test.ts
 */
export const NotificationFailed = /* @__PURE__ */ defineFailure('payments.notification_failed', {
  status: 502,
  data: z.object({
    channel: z.enum(['email', 'slack']),
    notification: notificationKindSchema,
    status: z.number().int().optional(),
  }),
  message: ({ channel, notification, status }) =>
    status === undefined
      ? `The ${channel} ${notification.replaceAll('_', ' ')} was not sent`
      : `The ${channel} ${notification.replaceAll('_', ' ')} was not sent: the server answered ${status}`,
  remediation: 'Check the transport or the Slack webhook URL, then send the notification again.',
});

/**
 * The host app's setup of a payments service cannot work: a capability a configured step needs was
 * not passed, or a setting is empty or malformed. Returned when the service is built (at boot) by its
 * `create` or factory function, never thrown, and never deferred to a later call as a silent no-op.
 *
 * @fix Pass the capability or setting that `setting` names when the app builds the service.
 * @verify bun run test -- src/core/services/dunning-service.test.ts src/dunning/communication-service.test.ts
 */
export const PaymentsConfigurationInvalid = /* @__PURE__ */ defineFailure('payments.configuration_invalid', {
  status: 500,
  data: z.object({ setting: z.string(), problem: z.string() }),
  message: 'Payments setting {setting} is invalid: {problem}',
  remediation: 'Pass the capability or setting it names when the app builds the service.',
});

/** Which counter column is full, in `CounterExhausted`. */
const counterSchema = z.enum([
  'retryCount',
  'attempts',
  'paymentsRecovered',
  'executions',
  'customersReached',
  'communicationsSent',
]);

/**
 * A counter column already holds 2^31 - 1 (`INT4_MAX`), the most an `integer` column can, or would pass
 * it with what the call adds, so it cannot go up. Nothing was written. `counter` names the column
 * (`retryCount` of a dunning execution, `attempts` of a webhook event, or `paymentsRecovered`,
 * `executions`, `customersReached` or `communicationsSent` of a campaign's analytics row) and `id` the
 * row. The update checks the column itself, so a full counter is never raised by a race between a read and a write.
 *
 * @fix Stop retrying the row: a counter this high was set by hand, since a correct caller stops long before it.
 * @verify bun run test -- src/dunning/campaign-service.test.ts src/core/repository.customers.test.ts
 */
export const CounterExhausted = /* @__PURE__ */ defineFailure('payments.counter_exhausted', {
  status: 409,
  data: z.object({ counter: counterSchema, id: z.string() }),
  message: 'The {counter} counter of {id} is full and cannot go up',
  remediation: 'Stop retrying the row; a correct caller stops long before the counter is full.',
});
