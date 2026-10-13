import type { Fields, Formatter, LogRecord, Value } from './types.js';
import { formatValue, isFieldMap, isValueArray, jsonMembers, jsonString, jsonValue } from './json.js';
import { LogEntry } from './record.js';
import { serializeError } from './serialize.js';
import { parseTemplate } from './template.js';

/**
 * One JSON object per record: `time`, `level`, `levelName`, `category`,
 * `template`, `message`, then `eventName`, `body`, `fields`, `error`, trace
 * ids and `resource` when present. Bound fields are written from JSON cached
 * once per `.with()`. When layers share a key, the merged map is written
 * instead, so every key appears once (RFC §5.2 precedence).
 */
export function json(): Formatter {
  const resources = new WeakMap<Fields, string>();
  return record => {
    let out = `{"time":${String(record.time)},"level":${String(record.level)},"levelName":"${record.levelName}","category":${jsonString(record.category)},"template":${jsonString(record.template)},"message":${jsonString(record.message())}`;
    if (record.eventName !== undefined) out += `,"eventName":${jsonString(record.eventName)}`;
    if (record.body !== undefined) out += `,"body":${jsonValue(record.body)}`;
    const members = fieldMembers(record);
    if (members !== '') out += `,"fields":{${members}}`;
    if (record.error !== undefined) out += `,"error":${jsonValue(record.error)}`;
    if (record.traceId !== undefined) out += `,"traceId":${jsonString(record.traceId)}`;
    if (record.spanId !== undefined) out += `,"spanId":${jsonString(record.spanId)}`;
    if (record.traceFlags !== undefined) out += `,"traceFlags":${String(record.traceFlags)}`;
    let resource = resources.get(record.resource);
    if (resource === undefined) {
      resource = jsonMembers(record.resource);
      resources.set(record.resource, resource);
    }
    if (resource !== '') out += `,"resource":{${resource}}`;
    return `${out}}`;
  };
}

function fieldMembers(record: LogRecord): string {
  if (!(record instanceof LogEntry) || !record.layered) return jsonMembers(record.fields);
  if (layersOverlap([record.shared, record.bound?.fields, record.scope, record.call])) {
    return jsonMembers(record.fields);
  }
  let out = '';
  const add = (part: string): void => {
    if (part === '') return;
    out = out === '' ? part : `${out},${part}`;
  };
  if (record.shared !== undefined) add(jsonMembers(record.shared));
  const bound = record.bound;
  if (bound !== undefined) {
    if (bound.json === undefined) bound.json = jsonMembers(bound.fields);
    add(bound.json);
  }
  if (record.scope !== undefined) add(jsonMembers(record.scope));
  if (record.call !== undefined) add(jsonMembers(record.call));
  return out;
}

/** True when a key in a later layer also appears in an earlier one. Layers are small. */
function layersOverlap(layers: readonly (Fields | undefined)[]): boolean {
  for (let later = 1; later < layers.length; later++) {
    const layer = layers[later];
    if (layer === undefined) continue;
    for (const key in layer) {
      for (let earlier = 0; earlier < later; earlier++) {
        const previous = layers[earlier];
        if (previous !== undefined && key in previous) return true;
      }
    }
  }
  return false;
}

const ANSI = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  cyan: '\u001B[36m',
  levels: {
    trace: '\u001B[90m',
    debug: '\u001B[34m',
    info: '\u001B[32m',
    warn: '\u001B[33m',
    error: '\u001B[31m',
    fatal: '\u001B[1;41;97m',
  },
} as const;

/**
 * Human output: `12:00:00.123 INFO  arki:kv connecting to db.local  pool=main`.
 * Placeholder values are highlighted; fields not used by the template follow.
 * Errors print their stack and cause chain. Colors are off unless asked for.
 */
export function pretty(options: { readonly colors?: boolean } = {}): Formatter {
  const colors = options.colors ?? false;
  const paint = (code: string, text: string): string => (colors ? `${code}${text}${ANSI.reset}` : text);
  return record => {
    const date = new Date(record.time);
    const time = `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
    const level = paint(ANSI.levels[record.levelName], record.levelName.toUpperCase().padEnd(5));
    const fields = record.fields;
    const parts = parseTemplate(record.template);
    const used = new Set<string>();
    let message = parts[0] ?? '';
    for (let index = 1; index < parts.length; index += 2) {
      const name = parts[index] ?? '';
      used.add(name);
      const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
      message += value === undefined ? `{${name}}` : paint(ANSI.cyan, formatValue(value));
      message += parts[index + 1] ?? '';
    }
    if (record.eventName !== undefined) {
      const body = record.body === undefined ? '' : ` ${jsonValue(record.body)}`;
      message =
        message === '' ? `${paint(ANSI.bold, record.eventName)}${body}` : `${message} ${record.eventName}${body}`;
    }
    let line = `${paint(ANSI.dim, time)} ${level} `;
    if (record.category !== '') line += `${paint(ANSI.dim, record.category)} `;
    line += message;
    for (const key in fields) {
      if (used.has(key) || fields[key] === undefined) continue;
      line += `  ${paint(ANSI.dim, `${key}=`)}${quoteIfNeeded(fields[key])}`;
    }
    if (record.error !== undefined) line += `\n${indent(errorText(serializeError(record.error)))}`;
    return line;
  };
}

/** `key=value` pairs: `time`, `level`, `category`, `msg`, then fields, `error` and trace ids. */
export function logfmt(): Formatter {
  return record => {
    let line = `time=${new Date(record.time).toISOString()} level=${record.levelName}`;
    if (record.category !== '') line += ` category=${quoteIfNeeded(record.category)}`;
    line += ` msg=${quoteIfNeeded(record.message())}`;
    if (record.eventName !== undefined) line += ` event=${quoteIfNeeded(record.eventName)}`;
    if (record.body !== undefined) line += ` body=${quoteIfNeeded(jsonValue(record.body))}`;
    const fields = record.fields;
    for (const key in fields) {
      const value = fields[key];
      if (value === undefined) continue;
      line += ` ${key}=${quoteIfNeeded(value)}`;
    }
    if (record.error !== undefined) line += ` error=${quoteIfNeeded(`${record.error.name}: ${record.error.message}`)}`;
    if (record.traceId !== undefined) line += ` trace_id=${record.traceId}`;
    if (record.spanId !== undefined) line += ` span_id=${record.spanId}`;
    return line;
  };
}

// eslint-disable-next-line no-control-regex
const BARE = /^[^\s"=\u0000-\u001F\\]+$/;

function quoteIfNeeded(value: Value): string {
  const text = isFieldMap(value) || isValueArray(value) ? jsonValue(value) : formatValue(value);
  return BARE.test(text) ? text : JSON.stringify(text);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n');
}

function errorText(error: Fields): string {
  const head =
    typeof error.stack === 'string' ? error.stack : `${formatValue(error.name)}: ${formatValue(error.message)}`;
  const cause = error.cause;
  if (isFieldMap(cause)) return `${head}\ncaused by: ${errorText(cause)}`;
  return cause === undefined ? head : `${head}\ncaused by: ${formatValue(cause)}`;
}
