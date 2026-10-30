import { defineApp } from '@arki/dot';

import { journal, journalWorker } from '../../../../dot.js';
import { dbUnit } from './db.js';
import { j } from './journal.js';
import { ordersFeature } from './features/orders/feature.js';
import { paymentsFeature } from './features/payments/feature.js';

/**
 * `dot explain --as event-map` runs in this folder: the scan reads `src/features`. The declared type is `object`
 * because the builder's inferred type names an unexported Dot type, which a declaration file cannot spell (TS2883);
 * Dot finds the app by its runtime shape.
 */
export const app: object = defineApp('event-map-fixture')
  .infra(dbUnit, journal({ j, workflowMeta: { actorId: 'system:workflow' } }))
  .features([ordersFeature, paymentsFeature])
  .entrypoints(journalWorker());
