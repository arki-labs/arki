/**
 * Refund effects: what happens after a refund write commits
 *
 * `createRefundEffects(j, refundsJournal)` returns the refund effects, to list in the app's `compose({ effects })`.
 * There is one today:
 *
 * - `refund-approval-request` mails the approvers about a refund that waits for a person. It runs on
 *   `RefundRequestedV2`, after the request committed: a request that rolled back sends nothing, and a retried
 *   request sends nothing more, because its receipt replays and records no event. A refund the auto-approval
 *   approved in the same request is no longer `pending` when the job runs, so it gets no mail; neither does one a
 *   person decided before the job ran.
 *
 * It needs `notifications`, given once in the app's `services`. A worker runs it. The mailer takes no key, so a
 * crash between the send and the ack sends the mail a second time.
 */

import { eq } from 'drizzle-orm';

import type { JournalDefinitions, RootDb, TransactionSource } from '@arki/journal';
import type { StandardSchemaV1 } from '@arki/schema';
import { isFailure } from '@arki/failure';
import { need } from '@arki/journal';
import { getLogger } from '@arki/log';

import type { NotificationService } from '../core/notifications/service.js';
import type { createRefundsJournal } from './journal.js';

export function createRefundEffects<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(j: JournalDefinitions<Meta, Tx, AppDb>, refundsJournal: ReturnType<typeof createRefundsJournal<Meta, Tx, AppDb>>) {
  const { refund } = refundsJournal.entities;
  const refunds = refund.table;

  const approvalRequest = j.effect(
    'refund-approval-request',
    refund,
    { notifications: need<NotificationService>() },
    {
      RefundRequestedV2: async (e, { db, notifications }) => {
        const [row] = await db.select().from(refunds).where(eq(refunds.id, e.entityId)).limit(1);
        if (row?.status !== 'pending') {
          return;
        }

        const sent = await notifications.sendRefundApprovalRequest?.(row);
        if (isFailure(sent)) {
          getLogger('arki:payments').warn('Refund {refundId} approval request was not sent: {code}', {
            refundId: row.id,
            code: sent.code,
            failure: sent,
          });
        }
      },
    },
  );

  return [approvalRequest] as const;
}
