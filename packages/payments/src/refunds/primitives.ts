import { createIdFactory } from '@arki/db/id-factory';

export type RefundId = ReturnType<typeof refundIdFactoryInstance.create>;

const refundIdFactoryInstance = createIdFactory('rfnd');

export const createRefundId = refundIdFactoryInstance.create;
export const refundIdSchema = refundIdFactoryInstance.schema;
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
