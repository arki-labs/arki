/**
 * Typed command-line programs from one `defineCommand`: flags from the input schema, a JSON envelope when piped, stable exit codes.
 */
export type { Cli, Io, Program } from './cli.js';
export { defineCli } from './cli.js';
export type {
  AnyCommand,
  AnyRunContext,
  Command,
  Effects,
  InputKeys,
  InputOf,
  Mode,
  NoInput,
  NoServices,
  OutputOf,
  RunContext,
  ServicesOf,
  Success,
} from './command.js';
export { defineCommand } from './command.js';
export type { Envelope, EnvelopeError, EnvelopeMeta, FailureEnvelope, OkEnvelope, Outcome } from './envelope.js';
export type { ExitCodeValue, InputIssue } from './failures.js';
export {
  Cancelled,
  ConfirmationRequired,
  ExitCode,
  InputRequired,
  InvalidInput,
  PreviewUnsupported,
  UnknownCommand,
} from './failures.js';
export { run } from './run.js';
export type { CommandTree, Group, TreeEntry, TreeNode } from './tree.js';
export { group } from './tree.js';
export type { Ui } from './ui.js';
