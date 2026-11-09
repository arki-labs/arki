import { z } from '@arki/contracts';

import { pgTextSchema } from '../core/pg-values.js';
import { refundReasonValues, refundStatusValues } from './primitives.js';

export const refundReasonSchema = z.enum(refundReasonValues);
export const refundStatusSchema = z.enum(refundStatusValues);

/** Why a refund was turned down, as the customer reads it. A blank reason says nothing, so it is refused. */
export const refundRejectionReasonSchema = pgTextSchema.trim().min(1);

export { refundReasonValues, refundStatusValues } from './primitives.js';
