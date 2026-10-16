/**
 * Runtime checks for what arrives from outside: a frame off the stream, a
 * cursor from storage or a dehydrated page. Plain functions over the
 * internal schemas, so no validator type leaks into the public API.
 */
import type { LiveCursor, LiveEvent } from './types.js';
import { liveCursorSchema, liveEventSchema } from './schema.js';

/** A frame, or `undefined` for anything that is not one (unknown kind, extra key, bad cursor, too many tags). */
export function parseLiveEvent(input: unknown): LiveEvent | undefined {
  const parsed = liveEventSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/** A cursor exactly as a frame gave it, or `undefined`. */
export function parseLiveCursor(input: unknown): LiveCursor | undefined {
  const parsed = liveCursorSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
