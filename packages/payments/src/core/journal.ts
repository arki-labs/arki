/**
 * Payments core on `@arki/journal`
 *
 * `createCoreJournal(j, { payments, subscriptions })` takes the app's journal
 * definitions and the app's two tables. It returns the entities, the events,
 * the commands, and `writes(run)`: plain async functions for the services.
 *
 * The package owns no database, no composed journal and no worker. The app
 * lists the tables in its schema and runs the commands through its own
 * command runner:
 *
 *   export const paymentsJournal = createCoreJournal(j, { payments, subscriptions });
 *   new SubscriptionManager(provider, repo, paymentsJournal.writes(context.runCommand));
 *
 * Every write of `payments` and `subscriptions` goes through one of these
 * commands. A rejected rule returns a failure of `@arki/journal`
 * (`CommandNotFound`, `CommandConflict`, `CommandInvalid`): nothing is written.
 */

import type {
  CommandRunner,
  JournalDefinitions,
  RootDb,
  TransactionSource,
} from '@arki/journal';
import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';

import type {
  CancelPaymentInput,
  CompletePaymentInput,
  FailPaymentInput,
  InitiatePaymentInput,
  MarkPaymentRequiresActionInput,
  RecordPaymentDisputeInput,
  RecordPaymentRefundInput,
} from './journal/payment.js';
import type {
  ActivateSubscriptionInput,
  CancelSubscriptionInput,
  ChangeSubscriptionPlanInput,
  CreateSubscriptionInput,
  MarkSubscriptionPastDueInput,
  PauseSubscriptionInput,
  ReactivateSubscriptionInput,
  ResumeSubscriptionInput,
  SetSubscriptionCancelAtPeriodEndInput,
  SyncSubscriptionInput,
} from './journal/subscription.js';
import type { CoreTables } from './tables.js';
import { createPaymentJournal } from './journal/payment.js';
import { createSubscriptionJournal } from './journal/subscription.js';
import { writtenRow } from './journal/support.js';

export {
  cancelPaymentInputSchema,
  completePaymentInputSchema,
  failPaymentInputSchema,
  initiatePaymentInputSchema,
  markPaymentRequiresActionInputSchema,
  recordPaymentDisputeInputSchema,
  recordPaymentRefundInputSchema,
} from './journal/payment.js';
export {
  activateSubscriptionInputSchema,
  cancelSubscriptionInputSchema,
  changeSubscriptionPlanInputSchema,
  createSubscriptionInputSchema,
  markSubscriptionPastDueInputSchema,
  pauseSubscriptionInputSchema,
  reactivateSubscriptionInputSchema,
  resumeSubscriptionInputSchema,
  setSubscriptionCancelAtPeriodEndInputSchema,
  syncSubscriptionInputSchema,
} from './journal/subscription.js';
export type {
  CancelPaymentInput,
  CompletePaymentInput,
  FailPaymentInput,
  InitiatePaymentInput,
  MarkPaymentRequiresActionInput,
  RecordPaymentDisputeInput,
  RecordPaymentRefundInput,
} from './journal/payment.js';
export type {
  ActivateSubscriptionInput,
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  MarkSubscriptionPastDueInput,
  PauseSubscriptionInput,
  ReactivateSubscriptionInput,
  ResumeSubscriptionInput,
  SyncSubscriptionInput,
} from './journal/subscription.js';

/**
 * What the services call to change a payment or a subscription. Each function
 * runs one command and returns the row as it is after the write, or the
 * failure the command returned when a rule said no (nothing was written).
 */
export type CoreWrites = ReturnType<ReturnType<typeof createCoreJournal>['writes']>;

export function createCoreJournal<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(j: JournalDefinitions<Meta, Tx, AppDb>, tables: Pick<CoreTables, 'payments' | 'subscriptions'>) {
  const payments = createPaymentJournal(j, tables.payments);
  const subscriptions = createSubscriptionJournal(j, tables.subscriptions);
  const commands = { ...payments.commands, ...subscriptions.commands };

  return {
    entities: { payment: payments.payment, subscription: subscriptions.subscription },
    events: { ...payments.events, ...subscriptions.events },
    commands,
    /** `run` is the app's command runner: `context.runCommand` in a request, `ctx.run` inside a command. */
    writes: (run: CommandRunner<SchemaOutput<Meta>, Tx>) => ({
      initiatePayment: (input: InitiatePaymentInput) =>
        writtenRow(run(commands.initiatePayment, input), 'initiatePayment'),
      completePayment: (input: CompletePaymentInput) =>
        writtenRow(run(commands.completePayment, input), 'completePayment'),
      failPayment: (input: FailPaymentInput) => writtenRow(run(commands.failPayment, input), 'failPayment'),
      cancelPayment: (input: CancelPaymentInput) => writtenRow(run(commands.cancelPayment, input), 'cancelPayment'),
      /** The customer must act (for example 3-D Secure). An already waiting payment stays as it is. */
      markPaymentRequiresAction: (input: MarkPaymentRequiresActionInput) =>
        writtenRow(run(commands.markPaymentRequiresAction, input), 'markPaymentRequiresAction'),
      /** The provider refunded the payment. A total that is not higher writes nothing. */
      recordPaymentRefund: (input: RecordPaymentRefundInput) =>
        writtenRow(run(commands.recordPaymentRefund, input), 'recordPaymentRefund'),
      /** The same dispute and status again writes nothing. */
      recordPaymentDispute: (input: RecordPaymentDisputeInput) =>
        writtenRow(run(commands.recordPaymentDispute, input), 'recordPaymentDispute'),
      createSubscription: (input: CreateSubscriptionInput) =>
        writtenRow(run(commands.createSubscription, input), 'createSubscription'),
      /** Create or update by provider subscription id. An unchanged delivery writes no event. */
      syncSubscription: (input: SyncSubscriptionInput) =>
        writtenRow(run(commands.syncSubscription, input), 'syncSubscription'),
      cancelSubscription: (input: CancelSubscriptionInput) =>
        writtenRow(run(commands.cancelSubscription, input), 'cancelSubscription'),
      reactivateSubscription: (input: ReactivateSubscriptionInput) =>
        writtenRow(run(commands.reactivateSubscription, input), 'reactivateSubscription'),
      pauseSubscription: (input: PauseSubscriptionInput) =>
        writtenRow(run(commands.pauseSubscription, input), 'pauseSubscription'),
      resumeSubscription: (input: ResumeSubscriptionInput) =>
        writtenRow(run(commands.resumeSubscription, input), 'resumeSubscription'),
      /** The same provider plan again writes nothing. */
      changeSubscriptionPlan: (input: ChangeSubscriptionPlanInput) =>
        writtenRow(run(commands.changeSubscriptionPlan, input), 'changeSubscriptionPlan'),
      /** Set or clear ends at period end without changing the status. */
      setSubscriptionCancelAtPeriodEnd: (input: SetSubscriptionCancelAtPeriodEndInput) =>
        writtenRow(run(commands.setSubscriptionCancelAtPeriodEnd, input), 'setSubscriptionCancelAtPeriodEnd'),
      markSubscriptionPastDue: (input: MarkSubscriptionPastDueInput) =>
        writtenRow(run(commands.markSubscriptionPastDue, input), 'markSubscriptionPastDue'),
      activateSubscription: (input: ActivateSubscriptionInput) =>
        writtenRow(run(commands.activateSubscription, input), 'activateSubscription'),
    }),
  };
}
