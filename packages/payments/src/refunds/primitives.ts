import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';
import { is } from '@arki/schema';

import { boundedIdSchema } from '../core/id-length.js';
import { holdsLoneSurrogate, pgTextSchema } from '../core/pg-values.js';

export type RefundId = IdOf<typeof refundIdFactoryInstance>;

const refundIdFactoryInstance = defineId('rfnd');

export const createRefundId = refundIdFactoryInstance.create;
/**
 * A refund id a command can store. Beyond the `rfnd` prefix it holds no U+0000 (the `refunds` row refuses it with
 * SQLSTATE 22021), no more characters than an id column holds, and no lone surrogate (the journal refuses an unpaired one in an entity id), so such an id is
 * `schema.invalid_input` before any query.
 */
export const refundIdSchema = boundedIdSchema(refundIdFactoryInstance.schema).refine(
  id => is(id, pgTextSchema) && !holdsLoneSurrogate(id),
  'A refund id cannot contain U+0000 or a lone surrogate',
);
export const refundIdFactory = refundIdFactoryInstance;

export const refundReasonValues = [
  'customer_request',
  'duplicate_charge',
  'fraudulent_transaction',
  'service_not_delivered',
  'billing_error',
  'technical_issue',
  'goodwill_gesture',
  'chargeback_prevention',
  'other',
] as const;

export const refundStatusValues = [
  'pending',
  'approved',
  'processing',
  'completed',
  'failed',
  'rejected',
  'canceled',
] as const;

export type RefundReason = (typeof refundReasonValues)[number];
export type RefundStatus = (typeof refundStatusValues)[number];
