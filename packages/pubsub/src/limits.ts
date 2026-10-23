/** The limits every backend enforces, so code moves between backends unchanged. */
import { PubSubError } from './errors.js';

/** A channel name: a Postgres identifier of 1 to 63 characters of `[a-z0-9_]`. */
export const CHANNEL_PATTERN = /^[a-z0-9_]{1,63}$/;

/** The largest payload, in UTF-8 bytes. Postgres NOTIFY refuses 8000 bytes or more, so the limit is 7999. */
export const MAX_PAYLOAD_BYTES = 7999;

const utf8 = new TextEncoder();

/** Throws a `channel` {@link PubSubError} unless `channel` matches {@link CHANNEL_PATTERN}. */
export function checkChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new PubSubError({
      code: 'channel',
      message: `channel ${JSON.stringify(channel.slice(0, 80))} is not 1 to 63 characters of [a-z0-9_]`,
      remediation: 'Use a short lower-case name such as orders_changed.',
    });
  }
}

/** Throws unless `channel` is valid and `payload` fits in {@link MAX_PAYLOAD_BYTES}. */
export function checkMessage(channel: string, payload: string): void {
  checkChannel(channel);
  const bytes = utf8.encode(payload).byteLength;
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new PubSubError({
      code: 'payload',
      message: `the payload on ${channel} is ${bytes} bytes; the limit is ${MAX_PAYLOAD_BYTES}`,
      remediation: 'Send an id and let the subscriber read the rest from the database.',
    });
  }
}

/** Throws a `closed` {@link PubSubError} when `closed` is true. */
export function checkOpen(closed: boolean, backend: string): void {
  if (closed) {
    throw new PubSubError({
      code: 'closed',
      message: `this ${backend} pubsub is closed`,
      remediation: 'Make a new pubsub, or close it only when the app shuts down.',
    });
  }
}
