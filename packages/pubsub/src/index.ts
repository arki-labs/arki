/** `@arki/pubsub`: the contract, its limits and its errors. Each backend lives on its own entry. */
export type { OnMessage, PubSub, TransactionalPubSub, Unsubscribe } from './types.js';
export { PUBSUB_ERROR_CODES, PubSubError } from './errors.js';
export type { PubSubErrorCode } from './errors.js';
export { CHANNEL_PATTERN, MAX_PAYLOAD_BYTES } from './limits.js';
