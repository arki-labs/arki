/**
 * Live queries on Drizzle tables (peer `drizzle-orm`): `live()` meta from Drizzle tables,
 * `tableTag`, `liveScopes()` (which tables are scoped, by which key column),
 * and `snapshot()` — one read-only snapshot per live query.
 */
export { live, tableTag } from './tables.js';
export { liveScopes } from './scopes.js';
export type { SnapshotRunner } from '../runner.js';
export type { SnapshotDatabase } from './snapshot.js';
export { snapshot } from './snapshot.js';
