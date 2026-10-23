/**
 * Option fields the Transformers.js model and reranker share. The peer is optional, so its runtime
 * lists of dtypes and devices cannot be imported here: each is checked as a non-empty string and
 * Transformers.js refuses an unknown one when it loads.
 */
import type { DataType, DeviceType, ProgressCallback } from '@huggingface/transformers';
import { z } from 'zod';

import { functionSchema } from '../schemas.js';

export const dtypeSchema = z.custom<DataType>(value => typeof value === 'string' && value !== '', 'expected a dtype name');
export const deviceSchema = z.custom<DeviceType>(value => typeof value === 'string' && value !== '', 'expected a device name');
// Annotated: declaration emit cannot name the peer's internal path for this type otherwise.
export const progressCallbackSchema: z.ZodCustom<ProgressCallback, ProgressCallback> = functionSchema<ProgressCallback>();
