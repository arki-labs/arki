/**
 * The `arki.cli/1` envelope: what a command writes in json mode, every key
 * always present. Built from a success, a returned failure, or a thrown error.
 */
import type { Failure } from '@arki/failure';

import type { ExitCodeValue, InputIssue } from './failures.js';
import { BUG_CODE, ExitCode, exitCodeOf, InvalidInput } from './failures.js';

export const ENVELOPE_SCHEMA = 'arki.cli/1';

/** What a failed command left behind: `unchanged` when it never ran, `unknown` when it may have changed things. */
export type Outcome = 'unchanged' | 'unknown';

export type EnvelopeMeta = {
  readonly schema: typeof ENVELOPE_SCHEMA;
  /** The CLI's version. */
  readonly version: string;
  /** Milliseconds from after parsing to the result. */
  readonly durationMs: number;
  /** True when `--dry-run` ran `preview` instead of `run`. */
  readonly dryRun: boolean;
};

export type EnvelopeError = {
  readonly code: string;
  readonly message: string;
  readonly remediation: string | null;
  /** The input problems of `cli.invalid_input`; empty otherwise. */
  readonly issues: readonly InputIssue[];
  /** The failure's data; null for `cli.invalid_input` (its issues are above) and for a bug. */
  readonly data: unknown;
  /** True for status 429 or 503: trying again later may work. */
  readonly retryable: boolean;
  readonly outcome: Outcome;
  readonly exitCode: ExitCodeValue;
  /** `<docsUrl>#<code>` when the CLI has a `docsUrl`, else null. */
  readonly docsUrl: string | null;
};

export type OkEnvelope<T> = {
  readonly ok: true;
  readonly command: readonly string[];
  /** What `run` returned; null when it returned nothing. */
  readonly data: T | null;
  readonly error: null;
  readonly meta: EnvelopeMeta;
};

export type FailureEnvelope = {
  readonly ok: false;
  readonly command: readonly string[];
  readonly data: null;
  readonly error: EnvelopeError;
  readonly meta: EnvelopeMeta;
};

export type Envelope<T> = OkEnvelope<T> | FailureEnvelope;

/** What every envelope of one run shares. */
export type EnvelopeContext = {
  readonly command: readonly string[];
  readonly version: string;
  readonly durationMs: number;
  readonly dryRun: boolean;
  readonly docsUrl: string | undefined;
};

function metaOf(context: EnvelopeContext): EnvelopeMeta {
  return {
    schema: ENVELOPE_SCHEMA,
    version: context.version,
    durationMs: context.durationMs,
    dryRun: context.dryRun,
  };
}

/** `https://x/docs#cli-invalid-input` for `cli.invalid_input`, or null without a base. */
export function docsUrlFor(base: string | undefined, code: string): string | null {
  return base === undefined ? null : `${base}#${code.replaceAll(/[._]/g, '-')}`;
}

export function okEnvelope<T>(data: T | undefined, context: EnvelopeContext): OkEnvelope<T> {
  return { ok: true, command: context.command, data: data ?? null, error: null, meta: metaOf(context) };
}

/** A failure, returned by `run` or raised by the framework. */
export function failureEnvelope(failure: Failure, context: EnvelopeContext): FailureEnvelope {
  const exitCode = exitCodeOf(failure);
  const invalid = InvalidInput.is(failure);
  return {
    ok: false,
    command: context.command,
    data: null,
    error: {
      code: failure.code,
      message: failure.message,
      remediation: failure.remediation ?? null,
      issues: invalid ? failure.data.issues : [],
      data: invalid ? null : (failure.data ?? null),
      retryable: exitCode === ExitCode.retry,
      outcome: exitCode === ExitCode.usage || exitCode === ExitCode.inputRequired ? 'unchanged' : 'unknown',
      exitCode,
      docsUrl: docsUrlFor(context.docsUrl, failure.code),
    },
    meta: metaOf(context),
  };
}

/** A thrown error: `cli.bug`, exit 1, the message only. The stack goes to the log, never into the envelope. */
export function bugEnvelope(error: unknown, context: EnvelopeContext): FailureEnvelope {
  return {
    ok: false,
    command: context.command,
    data: null,
    error: {
      code: BUG_CODE,
      message: error instanceof Error ? error.message : String(error),
      remediation: 'This is a bug in the command; report it with the command line that caused it.',
      issues: [],
      data: null,
      retryable: false,
      outcome: 'unknown',
      exitCode: ExitCode.bug,
      docsUrl: docsUrlFor(context.docsUrl, BUG_CODE),
    },
    meta: metaOf(context),
  };
}

/** The process exit code an envelope stands for. */
export function exitCodeOfEnvelope(envelope: Envelope<unknown>): ExitCodeValue {
  return envelope.ok ? ExitCode.ok : envelope.error.exitCode;
}
