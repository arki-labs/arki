import { z } from '@arki/contracts';

import { refundReasonValues, refundStatusValues } from './primitives.js';

export const refundReasonSchema = z.enum(refundReasonValues);
export const refundStatusSchema = z.enum(refundStatusValues);

export { refundReasonValues, refundStatusValues } from './primitives.js';
