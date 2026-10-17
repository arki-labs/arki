/**
 * `run`: the process boundary. Reads argv, wires stdio, the terminal and
 * SIGINT/SIGTERM into `main`, then exits with its code once stdout and
 * stderr are flushed. It does not configure `@arki/log`; the bin file does.
 */
import process from 'node:process';

import type { Program } from './cli.js';

/** Resolves once every write queued on `stream` before it has been flushed. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise(resolve => {
    stream.write('', () => {
      resolve();
    });
  });
}

/**
 * Run `program` as this process: `process.argv.slice(2)`, stdout and stderr,
 * `tty` from `process.stdout.isTTY`, `process.env`, and an abort signal for
 * SIGINT/SIGTERM (a run that ends after it exits 130). Never returns.
 *
 * @example
 * await run(defineCli({ name: 'app', version: '1.0.0', commands: { hello } }));
 */
export async function run(program: Program): Promise<never> {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const code = await program.main(process.argv.slice(2), {
    stdout: text => {
      process.stdout.write(text);
    },
    stderr: text => {
      process.stderr.write(text);
    },
    get stdin() {
      return process.stdin;
    },
    tty: process.stdout.isTTY === true,
    env: process.env,
    signal: controller.signal,
  });
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}
