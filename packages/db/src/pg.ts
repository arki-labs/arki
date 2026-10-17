/** Re-export of `drizzle-orm/pg-core`, so a table file imports from one place. */
export * from 'drizzle-orm/pg-core';
export type { ListenClient, ListenOptions, ListenPool } from './pg-listen.js';
export { listenOnPool, unrefTimer } from './pg-listen.js';
