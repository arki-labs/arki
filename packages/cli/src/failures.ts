/**
 * The six framework failures and the exit codes. This file is the one place
 * exit codes live: `ExitCode` names them and `FAILURE_EXIT_CODES` maps each
 * framework failure to one.
 */
import type { StandardSchemaV1 } from '@arki/schema';
import { is, recordSchema } from '@arki/schema';
import { defineFailure } from '@arki/failure';

/** Process exit codes. Stable: scripts and agents branch on them. */
export const ExitCode = {
  ok: 0,
  /** A thrown error: a bug in the command or the framework. */
  bug: 1,
  /** The command line was wrong: unknown command, invalid input, `--dry-run` without a preview. */
  usage: 2,
  /** `run` returned a failure. */
  failure: 3,
  /** `run` returned a failure worth retrying (status 429 or 503). */
  retry: 4,
  /** Input or a confirmation was needed and there was no terminal to ask on. */
  inputRequired: 5,
  /** Interrupted by SIGINT or SIGTERM. */
  interrupted: 130,
} as const;

/** One of the {@link ExitCode} values. */
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** One input problem: the input key path, the flag the user typed, what is wrong. */
export type InputIssue = {
  readonly path: readonly string[];
  readonly flag: string | undefined;
  readonly message: string;
};

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

/** A Standard Schema from a type guard, so the failure data is typed without a validator dependency. */
function guarded<T>(name: string, guard: (value: unknown) => value is T): StandardSchemaV1<T> {
  return {
    '~standard': {
      version: 1,
      vendor: '@arki/cli',
      validate: value => (guard(value) ? { value } : { issues: [{ message: `not ${name} data` }] }),
    },
  };
}

type UnknownCommandData = { readonly received: string; readonly suggestions: readonly string[] };
type PreviewUnsupportedData = { readonly command: readonly string[] };
type InvalidInputData = { readonly issues: readonly InputIssue[] };
type InputRequiredData = { readonly field: string; readonly flag: string };
type ConfirmationRequiredData = { readonly flag: '--yes' };

function isInputIssue(value: unknown): value is InputIssue {
  return (
    is(value, recordSchema) &&
    isStringArray(value['path']) &&
    (value['flag'] === undefined || typeof value['flag'] === 'string') &&
    typeof value['message'] === 'string'
  );
}

/**
 * The command name is not one at this level. `suggestions` holds the close names and aliases.
 * @fix Use a name from `.error.data.suggestions`, or run `--help` to list the commands.
 * @verify <bin> --help
 */
export const UnknownCommand = defineFailure('cli.unknown_command', {
  message: 'Unknown command "{received}"',
  remediation: 'Run with --help to list the commands.',
  data: guarded(
    'cli.unknown_command',
    (value): value is UnknownCommandData =>
      is(value, recordSchema) && typeof value['received'] === 'string' && isStringArray(value['suggestions']),
  ),
});

/**
 * The command line does not fit the command's input. `issues` names each key and flag.
 * @fix Fix the flags named in `.error.issues`; `--help` lists them.
 * @verify <bin> <command> --json | jq -e .ok
 */
export const InvalidInput = defineFailure('cli.invalid_input', {
  message: data => data.issues.map(issue => issue.message).join('; '),
  remediation: 'Fix the flags named in the issues; run with --help to see them.',
  data: guarded(
    'cli.invalid_input',
    (value): value is InvalidInputData =>
      is(value, recordSchema) && Array.isArray(value['issues']) && value['issues'].every(issue => isInputIssue(issue)),
  ),
});

/**
 * `--dry-run` on a command without `preview`.
 * @fix Run the command without `--dry-run`, or give the command a `preview`.
 * @verify <bin> <command> --json | jq -e .ok
 */
export const PreviewUnsupported = defineFailure('cli.preview_unsupported', {
  message: 'This command has no dry run',
  remediation: 'Run it without --dry-run.',
  data: guarded(
    'cli.preview_unsupported',
    (value): value is PreviewUnsupportedData => is(value, recordSchema) && isStringArray(value['command']),
  ),
});

/**
 * A required value is missing and there is no terminal to ask for it.
 * @fix Pass the flag named in `.error.data.flag`.
 * @verify <bin> <command> --json | jq -e .ok
 */
export const InputRequired = defineFailure('cli.input_required', {
  message: 'Missing {field}',
  remediation: 'Pass the flag named in the failure data.',
  data: guarded(
    'cli.input_required',
    (value): value is InputRequiredData =>
      is(value, recordSchema) && typeof value['field'] === 'string' && typeof value['flag'] === 'string',
  ),
});

/**
 * The command asks for confirmation and there is no terminal to ask on.
 * @fix Pass `--yes` to confirm without a terminal.
 * @verify <bin> <command> --json | jq -e .ok
 */
export const ConfirmationRequired = defineFailure('cli.confirmation_required', {
  message: 'This command needs confirmation',
  remediation: 'Pass --yes to confirm without a terminal.',
  data: guarded(
    'cli.confirmation_required',
    (value): value is ConfirmationRequiredData => is(value, recordSchema) && value['flag'] === '--yes',
  ),
});

/**
 * The run was interrupted by SIGINT or SIGTERM.
 * @fix Check what the interrupted run changed, then run the command again.
 * @verify <bin> <command> --json | jq -e .ok
 */
export const Cancelled = defineFailure('cli.cancelled', {
  message: 'Cancelled',
  remediation: 'Run the command again; check what it changed first, the outcome is unknown.',
});

/** The exit code of each framework failure. */
export const FAILURE_EXIT_CODES: Readonly<Record<string, ExitCodeValue>> = {
  [UnknownCommand.code]: ExitCode.usage,
  [InvalidInput.code]: ExitCode.usage,
  [PreviewUnsupported.code]: ExitCode.usage,
  [InputRequired.code]: ExitCode.inputRequired,
  [ConfirmationRequired.code]: ExitCode.inputRequired,
  [Cancelled.code]: ExitCode.interrupted,
};

/** The code of a thrown error in an envelope. Not a failure definition: nothing returns it. */
export const BUG_CODE = 'cli.bug';

/**
 * The exit code for a failure: the framework's own from the table above; for
 * a failure `run` returned, `retry` when its status is 429 or 503, else `failure`.
 */
export function exitCodeOf(failure: { readonly code: string; readonly status: number }): ExitCodeValue {
  const framework = FAILURE_EXIT_CODES[failure.code];
  if (framework !== undefined) return framework;
  return isRetryable(failure.status) ? ExitCode.retry : ExitCode.failure;
}

/** Status 429 (too many requests) or 503 (unavailable): trying again later may work. */
export function isRetryable(status: number): boolean {
  return status === 429 || status === 503;
}
