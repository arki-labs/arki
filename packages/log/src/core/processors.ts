import type { Fields, LogRecord, Processor, Value } from './types.js';
import { isFieldMap } from './json.js';
import { updateRecord } from './record.js';
import { isFailureLike, serializeError, serializeFailure } from './serialize.js';

export type Censor = string | ((value: Value, path: string) => Value);

/**
 * Replaces the values at dot paths (RFC §7). `*` matches one level of keys or
 * array items (`'*.token'`). Paths are matched against the fields and the
 * serialised error. The copy renders its message from the redacted fields, so
 * a secret never reaches the message text.
 */
export function redact(paths: readonly string[], options: { readonly censor?: Censor } = {}): Processor {
  const compiled = paths.map(path => path.split('.'));
  const firstKeys = new Set(compiled.map(segments => segments[0] ?? ''));
  const anyFirst = firstKeys.has('*');
  const censorOption = options.censor ?? '[REDACTED]';
  const censor = typeof censorOption === 'function' ? censorOption : (): Value => censorOption;

  const apply = (value: Value, segments: readonly string[], index: number, path: string): Value => {
    if (index === segments.length) return censor(value, path);
    const segment = segments[index] ?? '';
    if (Array.isArray(value)) {
      const list: readonly Value[] = value;
      let copy: Value[] | undefined;
      for (let item = 0; item < list.length; item++) {
        if (segment !== '*' && segment !== String(item)) continue;
        const child = list[item];
        const next = apply(child, segments, index + 1, path === '' ? String(item) : `${path}.${String(item)}`);
        if (next !== child) {
          copy ??= [...list];
          copy[item] = next;
        }
      }
      return copy ?? value;
    }
    if (isFailureLike(value)) {
      // Like the error below: redact the serialised failure, so paths reach its data and causes.
      const serialised = serializeFailure(value);
      const redacted = apply(serialised, segments, index, path);
      return redacted === serialised ? value : redacted;
    }
    if (!isFieldMap(value)) return value;
    let copy: Record<string, Value> | undefined;
    const keys = segment === '*' ? Object.keys(value) : Object.hasOwn(value, segment) ? [segment] : [];
    for (const key of keys) {
      const child = value[key];
      const next = apply(child, segments, index + 1, path === '' ? key : `${path}.${key}`);
      if (next !== child) {
        copy ??= { ...value };
        copy[key] = next;
      }
    }
    return copy ?? value;
  };

  const applyAll = (fields: Fields): Fields => {
    let current: Value = fields;
    for (const segments of compiled) current = apply(current, segments, 0, '');
    return isFieldMap(current) ? current : fields;
  };

  return record => {
    const fields = record.fields;
    let nextFields = fields;
    if (anyFirst || hasAnyKey(fields, firstKeys)) nextFields = applyAll(fields);
    let nextError = record.error;
    if (nextError !== undefined) {
      const serialised = serializeError(nextError);
      const redacted = applyAll(serialised);
      if (redacted !== serialised) nextError = errorFrom(redacted);
    }
    if (nextFields === fields && nextError === record.error) return record;
    return updateRecord(record, { fields: nextFields, error: nextError });
  };
}

/** Values shorter than this are never masked: too likely to match ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/**
 * Replaces every occurrence of a known secret value, wherever it appears: the template, string
 * fields at any depth, the serialised error, the body. `redact` hides values at known paths; this
 * hides known values at any path, for a secret that was revealed and then logged by hand. `values`
 * is read per record, so secrets loaded after `configure()` are covered too.
 */
export function maskSecrets(values: () => readonly string[], options: { readonly censor?: string } = {}): Processor {
  const censor = options.censor ?? '[REDACTED]';

  const mask = (value: Value, secrets: readonly string[]): Value => {
    if (typeof value === 'string') {
      let text = value;
      for (const secret of secrets) text = text.replaceAll(secret, censor);
      return text;
    }
    if (Array.isArray(value)) {
      const list: readonly Value[] = value;
      let copy: Value[] | undefined;
      for (let index = 0; index < list.length; index++) {
        const next = mask(list[index], secrets);
        if (next !== list[index]) {
          copy ??= [...list];
          copy[index] = next;
        }
      }
      return copy ?? value;
    }
    if (isFailureLike(value)) {
      const serialised = serializeFailure(value);
      const masked = mask(serialised, secrets);
      return masked === serialised ? value : masked;
    }
    if (value instanceof Error) {
      // An error inside the fields (`{ err }`): mask its serialised form, like the record's own error.
      const serialised = serializeError(value);
      const masked = mask(serialised, secrets);
      return masked !== serialised && isFieldMap(masked) ? errorFrom(masked) : value;
    }
    if (!isFieldMap(value)) return value;
    let copy: Record<string, Value> | undefined;
    for (const key of Object.keys(value)) {
      const next = mask(value[key], secrets);
      if (next !== value[key]) {
        copy ??= { ...value };
        copy[key] = next;
      }
    }
    return copy ?? value;
  };

  return record => {
    // Longest first, so a secret that contains another is masked whole.
    const secrets = [...new Set(values())].filter(secret => secret.length >= MIN_SECRET_LENGTH);
    if (secrets.length === 0) return record;
    secrets.sort((a, b) => b.length - a.length);
    const template = mask(record.template, secrets);
    const fields = mask(record.fields, secrets);
    const body = record.body === undefined ? undefined : mask(record.body, secrets);
    let error = record.error;
    if (error !== undefined) {
      const serialised = serializeError(error);
      const masked = mask(serialised, secrets);
      if (masked !== serialised && isFieldMap(masked)) error = errorFrom(masked);
    }
    if (template === record.template && fields === record.fields && body === record.body && error === record.error) return record;
    return updateRecord(record, {
      ...(typeof template === 'string' && template !== record.template ? { template } : {}),
      ...(isFieldMap(fields) && fields !== record.fields ? { fields } : {}),
      ...(body === record.body ? {} : { body }),
      error,
    });
  };
}

/** Adds fields from `fn`. Never overwrites a key the record already has. */
export function enrich(fn: (record: LogRecord) => Fields): Processor {
  return record => {
    const extra = fn(record);
    const fields = record.fields;
    let out: Record<string, Value> | undefined;
    for (const key in extra) {
      if (Object.hasOwn(fields, key)) continue;
      out ??= { ...fields };
      out[key] = extra[key];
    }
    return out === undefined ? record : updateRecord(record, { fields: out });
  };
}

/** Drops records the predicate matches. */
export function dropWhen(predicate: (record: LogRecord) => boolean): Processor {
  return record => (predicate(record) ? null : record);
}

function hasAnyKey(fields: Fields, keys: ReadonlySet<string>): boolean {
  for (const key of keys) if (Object.hasOwn(fields, key)) return true;
  return false;
}

/** An Error that serialises to the given (redacted) fields. */
function errorFrom(serialised: Fields): Error {
  const error = new Error(typeof serialised.message === 'string' ? serialised.message : '');
  for (const key of Object.keys(serialised)) {
    if (key === 'message') continue;
    const enumerable = key !== 'name' && key !== 'stack' && key !== 'cause' && key !== 'errors';
    Object.defineProperty(error, key, { value: serialised[key], enumerable, writable: true, configurable: true });
  }
  return error;
}
