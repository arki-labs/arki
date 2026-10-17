/**
 * Where a result goes: the mode (`-o`, `--json`, `ARKI_OUTPUT`, the
 * terminal), `--fields`, ndjson lines, and the default text rendering.
 */
import type { Mode } from './command.js';
import type { Envelope } from './envelope.js';
import type { Ui } from './ui.js';
import { OUTPUT_CHOICES } from './flags.js';

export type OutputChoice = (typeof OUTPUT_CHOICES)[number];

export function isOutputChoice(value: string): value is OutputChoice {
  const choices: readonly string[] = OUTPUT_CHOICES;
  return choices.includes(value);
}

/**
 * The mode of a run: `--json` first, then `-o`, then `ARKI_OUTPUT`, then
 * `auto`. `auto` is json when stdout is not a terminal (a pipe or an agent),
 * else text. An `ARKI_OUTPUT` that is not a mode is ignored.
 */
export function resolveMode(options: {
  readonly json: boolean;
  readonly output: OutputChoice | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tty: boolean;
}): Mode {
  if (options.json) return 'json';
  const fromEnv = options.env['ARKI_OUTPUT'];
  const choice = options.output ?? (fromEnv !== undefined && isOutputChoice(fromEnv) ? fromEnv : 'auto');
  if (choice !== 'auto') return choice;
  return options.tty ? 'text' : 'json';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `a,b.c` → `[['a'], ['b', 'c']]`. */
export function parseFields(raw: string): readonly (readonly string[])[] {
  return raw
    .split(',')
    .map(field => field.trim())
    .filter(field => field !== '')
    .map(field => field.split('.'));
}

/**
 * Keep only `paths` of `value`. An array keeps the paths of each element; a
 * path that is missing is left out, never filled with null.
 */
export function pickFields(value: unknown, paths: readonly (readonly string[])[]): unknown {
  if (Array.isArray(value)) return value.map(entry => pickFields(entry, paths));
  if (!isRecord(value)) return value;
  const picked: Record<string, unknown> = {};
  const byHead = new Map<string, (readonly string[])[]>();
  for (const [head, ...tail] of paths) {
    if (head === undefined || !Object.hasOwn(value, head)) continue;
    const tails = byHead.get(head) ?? [];
    tails.push(tail);
    byHead.set(head, tails);
  }
  for (const [head, tails] of byHead) {
    const whole = tails.some(tail => tail.length === 0);
    picked[head] = whole ? value[head] : pickFields(value[head], tails);
  }
  return picked;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

/** Padded columns, one header row, no box drawing. */
function table(rows: readonly Readonly<Record<string, unknown>>[]): string {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cells = [columns, ...rows.map(row => columns.map(column => cell(row[column])))];
  const widths = columns.map((_, index) => Math.max(...cells.map(row => (row[index] ?? '').length)));
  return cells
    .map(row =>
      row
        .map((text, index) => (index === row.length - 1 ? text : text.padEnd(widths[index] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** The default text for a result: `key: value` lines for an object, a table for an array of objects. */
export function renderText(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (Array.isArray(data)) {
    if (data.length > 0 && data.every(entry => isRecord(entry))) return table(data);
    return data.map(entry => cell(entry)).join('\n');
  }
  if (isRecord(data)) {
    return Object.entries(data)
      .map(([key, value]) => `${key}: ${cell(value)}`)
      .join('\n');
  }
  return cell(data);
}

export type WriteOptions = {
  readonly mode: Mode;
  /** The program name, for the text-mode failure line. */
  readonly name: string;
  readonly ui: Ui;
  readonly render: ((data: unknown, ui: Ui) => void) | undefined;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

/**
 * Write an envelope in the run's mode. json: the envelope on one line.
 * ndjson: one line per element of `data.items`, then the envelope without
 * `data`. text: `render` or the default on stdout; a failure on stderr.
 */
export function writeEnvelope(envelope: Envelope<unknown>, options: WriteOptions): void {
  const { mode, stdout, stderr } = options;
  if (mode === 'json') {
    stdout(`${JSON.stringify(envelope)}\n`);
    return;
  }
  if (mode === 'ndjson') {
    const items = envelope.ok && isRecord(envelope.data) ? envelope.data['items'] : undefined;
    if (!Array.isArray(items)) {
      stdout(`${JSON.stringify(envelope)}\n`);
      return;
    }
    for (const item of items) stdout(`${JSON.stringify(item)}\n`);
    const { ok, command, error, meta } = envelope;
    stdout(`${JSON.stringify({ ok, command, error, meta })}\n`);
    return;
  }
  if (!envelope.ok) {
    const { error } = envelope;
    stderr(`${options.name}: ${error.code} ${error.message}\n`);
    if (error.remediation !== null) stderr(`${error.remediation}\n`);
    return;
  }
  if (options.render !== undefined) {
    options.render(envelope.data, options.ui);
    return;
  }
  const text = renderText(envelope.data);
  if (text !== '') stdout(`${text}\n`);
}
