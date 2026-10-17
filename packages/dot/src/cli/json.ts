/**
 * The `data` shape of `dot new`: the app and the file operations, without
 * the in-memory file contents.
 */

import type { FileOperation } from './files.js';

/** One file `dot new` plans or writes, as printed in `.data.operations[]`. */
export type DotNewOperation = {
  readonly path: string;
  readonly action: FileOperation['action'];
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly reason: string;
};

/** What `dot new` returns: the same shape for `--dry-run` and a real run. */
export type DotNewResult = {
  readonly app: {
    readonly name: string;
    readonly target: string;
  };
  readonly operations: readonly DotNewOperation[];
  /** The commands to run next, from the directory `dot new` ran in. */
  readonly nextSteps: readonly string[];
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
