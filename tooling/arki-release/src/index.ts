/**
 * Public surface of `@arki/arki-release` for in-monorepo consumers.
 *
 * Re-exports the shared types, JSON envelope helpers, and CLI primitives
 * so future tasks (and tests) can import a single entry point:
 *
 *   import { createEnvelope, emitEnvelope } from '@arki/arki-release';
 *   import type { ReleaseCommandEnvelope } from '@arki/arki-release';
 */

export { createEnvelope, emitEnvelope, renderHumanText } from './json-output';
export type { CreateEnvelopeOptions, EmitEnvelopeOptions } from './json-output';

export { dispatch, parseArgs } from './cli';

export type {
  PackageWave,
  ParsedCliArgs,
  ReleaseCommand,
  ReleaseCommandEnvelope,
  ReleaseError,
  ReleaseErrorSeverity,
  ReleaseStatus,
} from './types';
