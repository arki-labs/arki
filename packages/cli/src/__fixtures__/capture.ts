import type { Io, Program } from '../cli.js';

/** Run `program.main` piped (no terminal) unless `io` says otherwise, and keep what it wrote. */
export async function capture(program: Program, argv: readonly string[], io: Partial<Io> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await program.main(argv, {
    stdout: text => {
      stdout += text;
    },
    stderr: text => {
      stderr += text;
    },
    tty: false,
    env: {},
    ...io,
  });
  return { exitCode, stdout, stderr };
}

/** The envelope a piped run wrote, with `durationMs` zeroed so it can be compared. */
export function envelopeOf(stdout: string): unknown {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== 'object' || parsed === null || !('meta' in parsed)) return parsed;
  const { meta } = parsed;
  return { ...parsed, meta: typeof meta === 'object' && meta !== null ? { ...meta, durationMs: 0 } : meta };
}

/** `value` as a record, or a thrown error naming what it was. */
export function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`expected an object, got ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
}

/** The JSON object a piped run wrote. */
export function json(stdout: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(stdout);
  return record(parsed);
}
