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
 * commands. A rejected rule throws the `CommandError` of `@arki/journal`.
 */

import type { z } from '@arki/contracts';
import type { CommandRunner, JournalDefinitions, RootDb, TransactionSource } from '@arki/journal';

import type {
  CancelPaymentInput,
  CompletePaymentInput,
  FailPaymentInput,
  InitiatePaymentInput,
} from './journal/payment.js';
import type {
  ActivateSubscriptionInput,
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  MarkSubscriptionPastDueInput,
  PauseSubscriptionInput,
  ReactivateSubscriptionInput,
  ResumeSubscriptionInput,
  SyncSubscriptionInput,
} from './journal/subscription.js';
import type { CoreTables } from './tables.js';
import type { Payment, Subscription } from './types.js';
import { createPaymentJournal } from './journal/payment.js';
import { createSubscriptionJournal } from './journal/subscription.js';
import { writtenRow } from './journal/support.js';

export {
  cancelPaymentInputSchema,
  completePaymentInputSchema,
  failPaymentInputSchema,
  initiatePaymentInputSchema,
} from './journal/payment.js';
export {
  activateSubscriptionInputSchema,
  cancelSubscriptionInputSchema,
  createSubscriptionInputSchema,
  markSubscriptionPastDueInputSchema,
  pauseSubscriptionInputSchema,
  reactivateSubscriptionInputSchema,
  resumeSubscriptionInputSchema,
  syncSubscriptionInputSchema,
} from './journal/subscription.js';
export type {
  CancelPaymentInput,
  CompletePaymentInput,
  FailPaymentInput,
  InitiatePaymentInput,
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
 * runs one command and returns the row as it is after the write.
 */
export type CoreWrites = {
  initiatePayment(input: InitiatePaymentInput): Promise<Payment>;
  completePayment(input: CompletePaymentInput): Promise<Payment>;
  failPayment(input: FailPaymentInput): Promise<Payment>;
  cancelPayment(input: CancelPaymentInput): Promise<Payment>;
  createSubscription(input: CreateSubscriptionInput): Promise<Subscription>;
  /** Create or update by the provider's subscription id. A delivery that changes nothing writes no event. */
  syncSubscription(input: SyncSubscriptionInput): Promise<Subscription>;
  cancelSubscription(input: CancelSubscriptionInput): Promise<Subscription>;
  reactivateSubscription(input: ReactivateSubscriptionInput): Promise<Subscription>;
  pauseSubscription(input: PauseSubscriptionInput): Promise<Subscription>;
  resumeSubscription(input: ResumeSubscriptionInput): Promise<Subscription>;
  markSubscriptionPastDue(input: MarkSubscriptionPastDueInput): Promise<Subscription>;
  activateSubscription(input: ActivateSubscriptionInput): Promise<Subscription>;
};

export function createCoreJournal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  j: JournalDefinitions<Meta, Tx, AppDb>,
  tables: Pick<CoreTables, 'payments' | 'subscriptions'>,
) {
  const payments = createPaymentJournal(j, tables.payments);
  const subscriptions = createSubscriptionJournal(j, tables.subscriptions);
  const commands = { ...payments.commands, ...subscriptions.commands };

  return {
    entities: { payment: payments.payment, subscription: subscriptions.subscription },
    events: { ...payments.events, ...subscriptions.events },
    commands,
    /** `run` is the app's command runner: `context.runCommand` in a request, `ctx.run` inside a command. */
    writes: (run: CommandRunner<z.output<Meta>, Tx>): CoreWrites => ({
      initiatePayment: input => writtenRow(run(commands.initiatePayment, input), 'initiatePayment'),
      completePayment: input => writtenRow(run(commands.completePayment, input), 'completePayment'),
      failPayment: input => writtenRow(run(commands.failPayment, input), 'failPayment'),
      cancelPayment: input => writtenRow(run(commands.cancelPayment, input), 'cancelPayment'),
      createSubscription: input => writtenRow(run(commands.createSubscription, input), 'createSubscription'),
      syncSubscription: input => writtenRow(run(commands.syncSubscription, input), 'syncSubscription'),
      cancelSubscription: input => writtenRow(run(commands.cancelSubscription, input), 'cancelSubscription'),
      reactivateSubscription: input =>
        writtenRow(run(commands.reactivateSubscription, input), 'reactivateSubscription'),
      pauseSubscription: input => writtenRow(run(commands.pauseSubscription, input), 'pauseSubscription'),
      resumeSubscription: input => writtenRow(run(commands.resumeSubscription, input), 'resumeSubscription'),
      markSubscriptionPastDue: input =>
        writtenRow(run(commands.markSubscriptionPastDue, input), 'markSubscriptionPastDue'),
      activateSubscription: input => writtenRow(run(commands.activateSubscription, input), 'activateSubscription'),
    }),
  };
}
