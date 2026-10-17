/**
 * `Ui`: how a command talks to the person at the terminal. `out` is the one
 * stdout channel in text mode; `info` and `warn` go to stderr. In json and
 * ndjson mode stdout belongs to the envelope, so all three are silent.
 */
import type { Mode } from './command.js';

export type Ui = {
  /** A line on stdout, text mode only. */
  out(text: string): void;
  /** A line on stderr. Muted by `-q` and in json/ndjson mode. */
  info(text: string): void;
  /** A `warning:` line on stderr. Muted by `-q` and in json/ndjson mode. */
  warn(text: string): void;
};

export type UiOptions = {
  readonly mode: Mode;
  readonly quiet: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

function line(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function createUi({ mode, quiet, stdout, stderr }: UiOptions): Ui {
  const text = mode === 'text';
  const talk = text && !quiet;
  return {
    out: value => {
      if (text) stdout(line(value));
    },
    info: value => {
      if (talk) stderr(line(value));
    },
    warn: value => {
      if (talk) stderr(line(`warning: ${value}`));
    },
  };
}
