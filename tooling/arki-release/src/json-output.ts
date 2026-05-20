/**
 * Shared JSON envelope helpers for the `@arki/arki-release` CLI.
 *
 * Every subcommand emits a `ReleaseCommandEnvelope` (see `./types`).
 * The envelope is the source of truth for both `--json` (machine) output
 * and the human-readable text rendering — they must agree on status.
 */

import type { ReleaseCommand, ReleaseCommandEnvelope, ReleaseError, ReleaseStatus } from './types';

/**
 * Options for {@link createEnvelope}.
 */
export interface CreateEnvelopeOptions<TItem, TSummary> {
  command: ReleaseCommand | 'help';
  status: ReleaseStatus;
  summary: TSummary;
  items?: TItem[];
  errors?: ReleaseError[];
}

/**
 * Build a {@link ReleaseCommandEnvelope} with a fresh ISO-8601 timestamp.
 *
 * Centralizing construction guarantees every subcommand produces the same
 * envelope shape; CI gates and downstream tooling can parse the result
 * deterministically.
 */
export function createEnvelope<TItem = unknown, TSummary = unknown>(
  opts: CreateEnvelopeOptions<TItem, TSummary>,
): ReleaseCommandEnvelope<TItem, TSummary> {
  return {
    status: opts.status,
    command: opts.command,
    generatedAt: new Date().toISOString(),
    summary: opts.summary,
    items: opts.items ?? [],
    errors: opts.errors ?? [],
  };
}

/**
 * Options for {@link emitEnvelope}.
 */
export interface EmitEnvelopeOptions {
  /** When `true`, write pretty JSON; otherwise render a human summary. */
  json: boolean;
  /** Override stdout target (defaults to `process.stdout.write`). */
  write?: (chunk: string) => void;
}

/**
 * Emit an envelope to stdout.
 *
 * - When `json` is `true`, pretty-prints the envelope as JSON (two-space
 *   indent) followed by a newline. Coding agents and CI gates parse this.
 * - When `json` is `false`, renders a short human-readable summary derived
 *   from the same envelope (status, command, headline message, error list).
 *
 * Text output is rendered from the envelope so the two modes cannot drift —
 * a stub that says `pending` in JSON cannot accidentally print `success`
 * to humans.
 */
export function emitEnvelope<TItem, TSummary>(
  envelope: ReleaseCommandEnvelope<TItem, TSummary>,
  opts: EmitEnvelopeOptions,
): void {
  const write =
    opts.write ??
    ((chunk: string): void => {
      process.stdout.write(chunk);
    });

  if (opts.json) {
    write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  write(renderHumanText(envelope));
}

/**
 * Render the envelope as human-readable text.
 *
 * Exposed for testing; subcommand handlers should call {@link emitEnvelope}.
 */
export function renderHumanText<TItem, TSummary>(envelope: ReleaseCommandEnvelope<TItem, TSummary>): string {
  const lines: string[] = [];
  lines.push(`[${envelope.status}] ${envelope.command}`);
  lines.push(`generated: ${envelope.generatedAt}`);

  const headline = extractHeadline(envelope.summary);
  if (headline !== null) {
    lines.push(headline);
  }

  if (envelope.items.length > 0) {
    lines.push(`items: ${envelope.items.length.toString()}`);
  }

  if (envelope.errors.length > 0) {
    lines.push('');
    lines.push(`errors (${envelope.errors.length.toString()}):`);
    for (const err of envelope.errors) {
      lines.push(`  - [${err.severity}] ${err.code}: ${err.message}`);
      if (err.target !== undefined) {
        lines.push(`      target: ${err.target}`);
      }
      if (err.remediation !== undefined) {
        lines.push(`      fix: ${err.remediation}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Best-effort headline extractor for the human renderer.
 *
 * Looks for common conventional fields on the summary object (`message`,
 * `headline`, `note`) and returns the first one found. Returns `null` when
 * the summary is not a plain object or contains no recognized field.
 */
function extractHeadline(summary: unknown): string | null {
  if (summary === null || typeof summary !== 'object') {
    return null;
  }
  const record = summary as Record<string, unknown>;
  for (const key of ['message', 'headline', 'note'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

export type { ReleaseCommandEnvelope, ReleaseError, ReleaseStatus } from './types';
