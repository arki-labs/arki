import { defineFeature } from '@arki/dot/feature';
import { infra } from '@arki/dot/unit';
import type { DepsOf } from '@arki/dot/feature';

import { ignore } from '../../journal.js';
import { journalHandlers, journalProjections } from '../../../../../../dot.js';
import { orderCount } from './infra/order-count.js';
import { orderFeed } from './usecases/order-feed.js';
import { sendReceipt } from './usecases/place-order.js';

const mailerUnit = infra({ name: 'mailer', provides: { mailer: () => ({ send: ignore }) } });

const core = defineFeature('orders').infra(mailerUnit, journalProjections(orderCount));

/** What a reaction of this feature may ask for (`import type { Deps } from '../feature'` in the reaction's file). */
export type Deps = DepsOf<typeof core>;

export const ordersFeature = core
  .usecases({}, journalHandlers(core, { effects: [sendReceipt], taps: [orderFeed] }))
  .entrypoints();
