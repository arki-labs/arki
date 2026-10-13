import type { ContextStore, Fields, LogRecord, Sink } from './types.js';
import { Level } from './levels.js';
import { reportFailure } from './report.js';

/**
 * Hands a record to a sink: the sink's own level floor, then its own
 * processors, then `write`. Wrappers use it for the sink they wrap. It never
 * throws: a failing processor drops the record (it may be a redactor), and a
 * failing sink loses only its own copy.
 */
export function deliver(sink: Sink, record: LogRecord): void {
  if (sink.level !== undefined && record.level < Level[sink.level]) return;
  const processors = sink.processors;
  let current: LogRecord | null = record;
  if (processors !== undefined) {
    for (const processor of processors) {
      try {
        current = processor(current);
      } catch (error) {
        reportFailure(processor, 'a sink processor', error);
        return;
      }
      if (current === null) return;
    }
  }
  try {
    sink.write(current);
  } catch (error) {
    reportFailure(sink, 'a sink', error);
  }
}

/**
 * The core's context store: correct for synchronous code only. A scope ends
 * when its callback returns, so an `await` inside loses it. Install
 * `asyncContext()` from `@arki/log/node` for async code.
 */
export function syncContext(): ContextStore {
  let current: Fields | undefined;
  return {
    get: () => current,
    run<R>(fields: Fields, fn: () => R): R {
      const previous = current;
      current = fields;
      try {
        return fn();
      } finally {
        current = previous;
      }
    },
  };
}
