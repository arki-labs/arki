/**
 * Runtime checks for what arrives from outside: a frame off the stream, a
 * cursor from storage or a dehydrated page. Plain functions over the
 * internal schemas, so no validator type leaks into the public API.
 */
import { parse } from '@arki/schema';

import { liveCursorSchema, liveEventSchema } from './schema.js';

/**
 * A frame, or a `schema.invalid_input` failure for anything that is not one
 * (unknown kind, extra key, bad cursor, too many tags).
 */
export function parseLiveEvent(input: unknown) {
  return parse(liveEventSchema, input);
}

/** A cursor exactly as a frame gave it, or a `schema.invalid_input` failure. */
export function parseLiveCursor(input: unknown) {
  return parse(liveCursorSchema, input);
}
