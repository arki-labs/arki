import type { LevelName } from './levels.js';
import type { Fields, LogRecord, TraceContext, Value } from './types.js';
import { levelNameOf } from './levels.js';
import { parseTemplate, renderParsed } from './template.js';

export const EMPTY_FIELDS: Fields = Object.freeze({});

/** Fields bound with `.with()`, plus their JSON, written once and reused (the "chindings" trick). */
export type BoundFields = { readonly fields: Fields; json: string | undefined };

/**
 * The one object a log call allocates. Fields stay in their layers (shared,
 * bound, scoped, call) and are merged only when something reads `fields`, so
 * a JSON sink can write the bound layer from its cached JSON instead.
 */
export class LogEntry implements LogRecord {
  readonly time: number;
  readonly level: number;
  readonly levelName: LevelName;
  readonly category: string;
  readonly template: string;
  readonly eventName: string | undefined;
  readonly body: Value;
  readonly error: Error | undefined;
  readonly traceId: string | undefined;
  readonly spanId: string | undefined;
  readonly traceFlags: number | undefined;
  readonly resource: Fields;
  /** The `withContext` scope this record was logged in; `fingersCrossed` keys its rings on it. */
  readonly scope: Fields | undefined;
  /** Layers in precedence order (later wins). `undefined` when built by `updateRecord`. */
  readonly shared: Fields | undefined;
  readonly bound: BoundFields | undefined;
  readonly call: Fields | undefined;
  /** True when built by a log call: the fields are still in their layers and no processor replaced them. */
  readonly layered: boolean;
  private merged: Fields | undefined;
  private rendered: string | undefined;

  constructor(
    time: number,
    level: number,
    category: string,
    template: string,
    shared: Fields | undefined,
    bound: BoundFields | undefined,
    scope: Fields | undefined,
    call: Fields | undefined,
    error: Error | undefined,
    trace: TraceContext | undefined,
    resource: Fields,
    eventName: string | undefined,
    body: Value,
    merged: Fields | undefined,
  ) {
    this.time = time;
    this.level = level;
    this.levelName = levelNameOf(level);
    this.category = category;
    this.template = template;
    this.eventName = eventName;
    this.body = body;
    this.error = error;
    this.traceId = trace?.traceId;
    this.spanId = trace?.spanId;
    this.traceFlags = trace?.traceFlags;
    this.resource = resource;
    this.scope = scope;
    this.shared = merged === undefined ? shared : undefined;
    this.bound = merged === undefined ? bound : undefined;
    this.call = merged === undefined ? call : undefined;
    this.layered = merged === undefined;
    this.merged = merged;
    this.rendered = undefined;
  }

  get fields(): Fields {
    if (this.merged === undefined) {
      this.merged = mergeLayers(this.shared, this.bound?.fields, this.scope, this.call);
    }
    return this.merged;
  }

  message(): string {
    if (this.rendered === undefined) {
      const parts = parseTemplate(this.template);
      // A template without placeholders never touches the fields, so the layers stay unmerged.
      this.rendered = parts.length === 1 ? (parts[0] ?? '') : renderParsed(parts, this.fields);
    }
    return this.rendered;
  }
}

/** Merges field layers; later layers win. Allocates only when two or more layers are present. */
export function mergeLayers(
  a: Fields | undefined,
  b: Fields | undefined,
  c: Fields | undefined,
  d: Fields | undefined,
): Fields {
  let only: Fields | undefined;
  let count = 0;
  if (a !== undefined) {
    only = a;
    count++;
  }
  if (b !== undefined) {
    only = b;
    count++;
  }
  if (c !== undefined) {
    only = c;
    count++;
  }
  if (d !== undefined) {
    only = d;
    count++;
  }
  if (count === 0 || only === undefined) return EMPTY_FIELDS;
  if (count === 1) return only;
  const out: Record<string, Value> = {};
  if (a !== undefined) assign(out, a);
  if (b !== undefined) assign(out, b);
  if (c !== undefined) assign(out, c);
  if (d !== undefined) assign(out, d);
  return out;
}

function assign(target: Record<string, Value>, source: Fields): void {
  for (const key in source) target[key] = source[key];
}

/** What `updateRecord` may change. */
export type RecordChanges = {
  readonly time?: number;
  readonly level?: number;
  readonly template?: string;
  readonly eventName?: string;
  readonly body?: Value;
  readonly fields?: Fields;
  readonly error?: Error | undefined;
};

/**
 * A copy of a record with some parts replaced, for processors. The copy
 * renders its message from its own fields, so a redacted value never reaches
 * `message()`.
 */
export function updateRecord(record: LogRecord, changes: RecordChanges): LogRecord {
  const trace: TraceContext | undefined =
    record.traceId !== undefined && record.spanId !== undefined
      ? { traceId: record.traceId, spanId: record.spanId, traceFlags: record.traceFlags }
      : undefined;
  return new LogEntry(
    changes.time ?? record.time,
    changes.level ?? record.level,
    record.category,
    changes.template ?? record.template,
    undefined,
    undefined,
    recordScope(record),
    undefined,
    'error' in changes ? changes.error : record.error,
    trace,
    record.resource,
    'eventName' in changes ? changes.eventName : record.eventName,
    'body' in changes ? changes.body : record.body,
    changes.fields ?? record.fields,
  );
}

/** The `withContext` scope a record was logged in, if the core built it. */
export function recordScope(record: LogRecord): Fields | undefined {
  return record instanceof LogEntry ? record.scope : undefined;
}
