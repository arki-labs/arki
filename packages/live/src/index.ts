/**
 * `@arki/live`: the portable core. Schemas and types of the wire and the meta,
 * `live()` meta from tags, `affectedPaths`, the hub, and the error codes.
 * Imports no optional peer.
 */
export type { LiveCursor, LiveEvent, LiveManifest, LiveMeta, TableTag } from './schema.js';
export { liveCursorSchema, liveEventSchema, liveManifestSchema, liveMetaSchema, tableTagSchema } from './schema.js';
export { affectedPaths, live } from './manifest.js';
export type { LiveFeed, LiveHub, LiveLimits, LiveSource, LiveSourceEvent } from './hub.js';
export { createLiveHub } from './hub.js';
export type { LiveError } from './errors.js';
export { LIVE_ERROR_CODES } from './errors.js';
