/**
 * The quickstart's deliberate mistake: `sessions` is mounted before the `database` it needs.
 *
 * Plain JavaScript on purpose. In TypeScript this line does not compile, so
 * the kernel's own check would never get a turn. Here nothing stops it until
 * `configure`, which is the point of the demo.
 */
import { defineApp } from '@arki/dot';

import { database, orders, sessions } from './quickstart.js';

// #region wrong-order
export default defineApp('shop').infra(sessions, database).features([orders]);
// #endregion wrong-order
