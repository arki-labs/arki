import { defineFeature } from '@arki/dot/feature';

import { journalHandlers } from '../../../../../../dot.js';
import { checkout, reserveStock } from './usecases/checkout.js';

const core = defineFeature('payments');

export const paymentsFeature = core.usecases({}, journalHandlers(core, { workflows: [checkout, reserveStock] })).entrypoints();
