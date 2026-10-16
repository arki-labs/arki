/**
 * `@arki/live`: the portable core. The types of the wire and the meta, their
 * runtime checks (`parseLiveEvent`, `parseLiveCursor`), `live()` meta from
 * tags, `affectedPaths`, `liveTables`, the hub, the stream client, and the
 * error codes.
 * Imports no optional peer.
 */
export type { LiveCursor, LiveEvent, LiveManifest, LiveMeta, TableTag } from './types.js';
export { parseLiveCursor, parseLiveEvent } from './parse.js';
export { affectedPaths, live, liveTables } from './manifest.js';
export type { LiveFeed, LiveHub, LiveLimits, LiveSource, LiveSourceEvent } from './hub.js';
export { createLiveHub } from './hub.js';
export type { LiveClient, LiveClientOptions, LiveStatus } from './client.js';
export { createLiveClient } from './client.js';
export type { LiveError } from './errors.js';
export { LIVE_ERROR_CODES } from './errors.js';
