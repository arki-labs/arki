/**
 * The quickstart's deliberate mistake: the consumer is mounted before its provider.
 *
 * Plain JavaScript on purpose. In TypeScript this line does not compile, so
 * the kernel's own check would never get a turn. Here nothing stops it until
 * `configure`, which is the point of the demo.
 */
import { defineApp } from '@arki/dot';

import { database, orders } from './quickstart.js';

// #region wrong-order
export default defineApp('shop').use(orders).use(database);
// #endregion wrong-order
