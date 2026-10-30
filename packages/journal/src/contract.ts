/**
 * Everything an oRPC contract needs from the journal, browser-safe: the
 * failures a command or a workflow operation returns (for the contract's error
 * map). Importing it never loads Drizzle, a database driver or the journal
 * runtime.
 */
export {
  COMMAND_FAILURES,
  CommandConflict,
  CommandForbidden,
  CommandInvalid,
  CommandNotFound,
  WorkflowBusy,
  WorkflowReadMismatch,
  WorkflowStranded,
  WorkflowTransitionLimit,
} from './errors.js';
export type { CommandFailure } from './errors.js';
