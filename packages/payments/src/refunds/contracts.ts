import { z } from '@arki/contracts';

import { holdsLoneSurrogate, pgTextSchema } from '../core/pg-values.js';
import { refundReasonValues, refundStatusValues } from './primitives.js';

export const refundReasonSchema = z.enum(refundReasonValues);
export const refundStatusSchema = z.enum(refundStatusValues);

/**
 * Why a refund was turned down, as the customer reads it. A blank reason says nothing, so it is refused. It is
 * kept in the `RefundRejected` event, whose jsonb data refuses U+0000 and a lone surrogate, so both are refused too.
 */
export const refundRejectionReasonSchema = pgTextSchema
  .trim()
  .min(1)
  .refine(reason => !holdsLoneSurrogate(reason), 'Text cannot contain a lone surrogate (such as U+D800 alone)');

export { refundReasonValues, refundStatusValues } from './primitives.js';
