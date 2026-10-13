import type { Formatter, LogRecord, Sink } from './types.js';
import { json } from './formatters.js';

/** A sink that keeps records in memory. */
export type MemorySink = Sink & {
  readonly records: readonly LogRecord[];
  clear(): void;
};

export function memorySink(): MemorySink {
  const records: LogRecord[] = [];
  return {
    records,
    write: record => {
      records.push(record);
    },
    clear: () => {
      records.length = 0;
    },
  };
}

/** Formats each record (JSON by default) and hands the line to `write`. */
export function lineSink(write: (line: string) => void, options: { readonly format?: Formatter } = {}): Sink {
  const format = options.format ?? json();
  return { write: record => write(format(record)) };
}

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error';

function consoleMethod(level: number): ConsoleMethod {
  if (level >= 17) return 'error';
  if (level >= 13) return 'warn';
  if (level >= 9) return 'info';
  return 'debug';
}

/**
 * Writes to `console`. With `format`, each record is one formatted line.
 * Without it (browser mode), the message is followed by the fields object and
 * the error, so devtools can expand them.
 */
export function consoleSink(options: { readonly format?: Formatter } = {}): Sink {
  const format = options.format;
  return {
    write: record => {
      const method = consoleMethod(record.level);
      if (format !== undefined) {
        console[method](format(record));
        return;
      }
      const head = `${record.levelName.toUpperCase()}${record.category === '' ? '' : ` [${record.category}]`} ${record.eventName ?? record.message()}`;
      const args: unknown[] = [head];
      if (record.body !== undefined) args.push(record.body);
      if (Object.keys(record.fields).length > 0) args.push(record.fields);
      if (record.error !== undefined) args.push(record.error);
      console[method](...args);
    },
  };
}
