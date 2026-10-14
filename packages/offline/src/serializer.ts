/**
 * The one serializer for everything this package writes to IndexedDB: the
 * persisted query cache and the mutation queues.
 *
 * Plain JSON would turn `Date`, `Map`, `BigInt` and the `@arki/date` Temporal
 * values the oRPC wire carries into strings or objects, and a restored cache
 * would then hand components values of the wrong type until each query
 * refetched. A private SuperJSON instance keeps them typed, and does not depend
 * on an app registering types on the shared SuperJSON singleton.
 */
import SuperJSON from 'superjson';

import { registerTemporalTypes } from '@arki/date/orpc';

export const offlineSerializer = new SuperJSON();
registerTemporalTypes(offlineSerializer);
