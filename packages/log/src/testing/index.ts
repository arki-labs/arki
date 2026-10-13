// @arki/log/testing: a fake that takes over the default logging instance (RFC §11).

import type { LevelName } from '../core/levels.js';
import type { Fields, LogRecord, Value } from '../core/types.js';
import { defaultLogging } from '../core/default.js';
import { formatValue, jsonMembers } from '../core/json.js';
import { INTERNAL } from '../core/logging.js';

/** What a captured record must match. Every given part must match; `fields` matches a subset. */
export type RecordMatch = {
  readonly level?: LevelName;
  readonly category?: string;
  readonly template?: string;
  readonly message?: string;
  readonly eventName?: string;
  readonly fields?: Fields;
};

/** A record and the channel names it was routed to. */
export type CapturedRecord = { readonly record: LogRecord; readonly channels: readonly string[] };

export type FakeLog = {
  /** Every record, from every category, at every level. */
  readonly records: readonly LogRecord[];
  /** Every record with the channels it was routed to (`to()`, else the configured category rule). */
  readonly captured: readonly CapturedRecord[];
  assertLogged(match: RecordMatch): void;
  assertNotLogged(match: RecordMatch): void;
  assertSentTo(channel: string, match?: RecordMatch): void;
  /** Gives the default instance back, with its configuration as it was. */
  restore(): void;
  [Symbol.dispose](): void;
};

/**
 * Takes over the default instance: level `trace`, every category captured,
 * no sink written. `restore()` (or `using`) gives it back. One fake at a time
 * per process; a second one throws `ARKI_LOG_E004`.
 */
export function fakeLog(): FakeLog {
  const records: LogRecord[] = [];
  const captured: CapturedRecord[] = [];
  const release = defaultLogging()[INTERNAL].installFake((record, channels) => {
    records.push(record);
    captured.push({ record, channels });
  });

  const fail = (text: string): never => {
    throw new LogAssertionError(`${text}\n${describeCaptured(captured)}`);
  };

  return {
    records,
    captured,
    assertLogged: match => {
      if (!records.some(record => matches(record, match))) fail(`Expected a record matching ${describe(match)}.`);
    },
    assertNotLogged: match => {
      const found = records.find(record => matches(record, match));
      if (found !== undefined) fail(`Expected no record matching ${describe(match)}, found: ${line(found)}.`);
    },
    assertSentTo: (channel, match = {}) => {
      if (!captured.some(entry => entry.channels.includes(channel) && matches(entry.record, match))) {
        fail(`Expected a record matching ${describe(match)} sent to channel "${channel}".`);
      }
    },
    restore: release,
    [Symbol.dispose]: release,
  };
}

export class LogAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogAssertionError';
  }
}

function matches(record: LogRecord, match: RecordMatch): boolean {
  if (match.level !== undefined && record.levelName !== match.level) return false;
  if (match.category !== undefined && record.category !== match.category) return false;
  if (match.template !== undefined && record.template !== match.template) return false;
  if (match.eventName !== undefined && record.eventName !== match.eventName) return false;
  if (match.message !== undefined && record.message() !== match.message) return false;
  if (match.fields !== undefined) {
    const fields = record.fields;
    for (const key in match.fields) {
      if (!Object.hasOwn(fields, key) || !same(fields[key], match.fields[key])) return false;
    }
  }
  return true;
}

function same(a: Value, b: Value): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Error || b instanceof Error) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    const left: readonly Value[] = a;
    const right: readonly Value[] = b;
    return left.length === right.length && left.every((item, index) => same(item, right[index]));
  }
  if (isMap(a) && isMap(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  return false;
}

function isMap(value: Value): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function describe(match: RecordMatch): string {
  const parts: string[] = [];
  if (match.level !== undefined) parts.push(`level=${match.level}`);
  if (match.category !== undefined) parts.push(`category=${JSON.stringify(match.category)}`);
  if (match.template !== undefined) parts.push(`template=${JSON.stringify(match.template)}`);
  if (match.message !== undefined) parts.push(`message=${JSON.stringify(match.message)}`);
  if (match.eventName !== undefined) parts.push(`eventName=${JSON.stringify(match.eventName)}`);
  if (match.fields !== undefined) parts.push(`fields={${jsonMembers(match.fields)}}`);
  return parts.length === 0 ? '(anything)' : `{ ${parts.join(', ')} }`;
}

function line(record: LogRecord): string {
  const fields = jsonMembers(record.fields);
  const error = record.error === undefined ? '' : ` error=${formatValue(record.error)}`;
  return `${record.levelName.toUpperCase()} [${record.category}] ${JSON.stringify(record.template)} → ${JSON.stringify(record.message())}${fields === '' ? '' : ` {${fields}}`}${error}`;
}

function describeCaptured(captured: readonly CapturedRecord[]): string {
  if (captured.length === 0) return 'Captured records: none.';
  const lines = captured.map(
    ({ record, channels }) => `  ${line(record)}${channels.length > 0 ? ` (to ${channels.join(', ')})` : ''}`,
  );
  return `Captured records (${String(captured.length)}):\n${lines.join('\n')}`;
}
