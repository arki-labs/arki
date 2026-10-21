/** `@arki/failure`: typed failures returned as plain values, with no wrapper. */
export { attempt } from './attempt.js';
export { findCause } from './cause.js';
export { collect, partition } from './collect.js';
export { FAILURE_ERROR_CODES, FailureError } from './errors.js';
export type { FailureErrorCode } from './errors.js';
export { defineFailure, isFailure, orThrow, stoppable, UnexpectedFailure } from './failure.js';
export type {
  AwaitFirst,
  DataOf,
  Failure,
  FailureDefinition,
  FailureIn,
  FailureOf,
  FailureOptions,
  MakeOptions,
  Result,
  Stoppable,
  SuccessOf,
} from './failure.js';
export { invariant, match, recover, unreachable } from './handle.js';
export type { MatchHandlers, RecoverHandlers } from './handle.js';
export { revive, reviveJson, serialize, REVIVAL_FAILURES } from './revive.js';
export { InvalidInput, AsyncSchema, ValidatorDefect, InvalidEnvelope, UnexpectedDefect } from './foundations.js';
export type { SchemaFailure, AsyncSchemaFailure } from './schema.js';
export type { RevivalFailure } from './revive.js';
export { isSchemaFailure, isAsyncSchemaFailure, SCHEMA_FAILURES } from './schema.js';
