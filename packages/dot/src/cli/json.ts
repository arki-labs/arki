/**
 * JSON envelope shapes for the `dot new` command.
 *
 * The envelope mirrors `DotCliEnvelope` in spirit but exposes the
 * scaffold-specific `app` + `operations` payload directly at the top level
 * so consumers don't have to dig under a generic `data` field.
 */

import type { DiagnosticIssue } from '../diagnostics.js';
import type { FileOperation } from './files.js';

/** Subset of {@link FileOperation} emitted in the JSON envelope. */
export type DotNewOperation = {
  readonly path: string;
  readonly action: FileOperation['action'];
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly reason: string;
};

/**
 * Envelope returned by `dot new`. Both dry-run and real runs share the
 * same shape, distinguished only by `errors` and per-operation `action`.
 *
 * `errors` carries the same {@link DiagnosticIssue} shape used everywhere
 * else in the CLI — agents already parse it.
 */
export type DotNewEnvelope = {
  readonly status: 'success' | 'failure';
  readonly command: 'new';
  readonly generatedAt: string;
  readonly app: {
    readonly name: string;
    readonly target: string;
  };
  readonly operations: readonly DotNewOperation[];
  readonly errors: readonly DiagnosticIssue[];
};

/** Strip the in-memory `content` field before serialising. */
export function toPublicOperation(op: FileOperation): DotNewOperation {
  return {
    path: op.path,
    action: op.action,
    contentHash: op.contentHash,
    contentBytes: op.contentBytes,
    reason: op.reason,
  };
}
