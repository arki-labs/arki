/**
 * `@arki/live/orpc` (peers `@orpc/server`, `@orpc/contract`): `liveRead()`,
 * the middleware that gives a live procedure one snapshot, and
 * `liveManifest()`, which reads the live procedures out of a contract.
 */
export type { LiveReadContext, LiveReadMiddleware } from './read.js';
export { liveRead } from './read.js';
export { liveManifest } from './manifest.js';
