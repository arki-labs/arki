import type { FieldInput, Fields, Value } from './types.js';
import { formatValue } from './json.js';

// ---------------------------------------------------------------------------
// Placeholder types (RFC §5.1)
// ---------------------------------------------------------------------------

/**
 * The placeholder names in a literal template. `{{` is a literal brace; `{}` and
 * a name that contains `{` are not placeholders. Tail-recursive, so long
 * templates do not hit the instantiation-depth limit. Mirrors `parseTemplate`.
 */
export type PlaceholderNames<T extends string, Acc extends string = never> = T extends `${string}{${infer Rest}`
  ? Rest extends `{${infer After}`
    ? PlaceholderNames<After, Acc>
    : Rest extends `${infer Name}}${infer After}`
      ? Name extends '' | `${string}{${string}`
        ? PlaceholderNames<Rest, Acc>
        : PlaceholderNames<After, Acc | Name>
      : Acc
  : Acc;

type PlaceholderFields<K extends string> = Readonly<Record<K, Value>> & Fields;

/**
 * The fields argument of a log call. A placeholder must be satisfied by the
 * call's fields or by fields already bound with `.with()` (the `Bound` keys).
 * A template typed as plain `string` accepts any fields.
 */
export type FieldsArg<T extends string, Bound extends string> = string extends T
  ? [fields?: FieldInput]
  : [Exclude<PlaceholderNames<T>, Bound>] extends [never]
    ? [fields?: FieldInput]
    : [
        fields:
          | PlaceholderFields<Exclude<PlaceholderNames<T>, Bound>>
          | (() => PlaceholderFields<Exclude<PlaceholderNames<T>, Bound>>),
      ];

// ---------------------------------------------------------------------------
// Runtime parser and renderer
// ---------------------------------------------------------------------------

/** Parsed template: even indexes are literal text, odd indexes are placeholder names. */
export type ParsedTemplate = readonly string[];

const MAX_CACHED_TEMPLATES = 1000;
const cache = new Map<string, ParsedTemplate>();

/** Parses a template once and caches it (bounded: the oldest entry goes when full). */
export function parseTemplate(template: string): ParsedTemplate {
  const hit = cache.get(template);
  if (hit !== undefined) return hit;
  const parsed = parse(template);
  if (cache.size >= MAX_CACHED_TEMPLATES) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(template, parsed);
  return parsed;
}

/** How many templates are cached. For tests. */
export function cachedTemplateCount(): number {
  return cache.size;
}

function parse(template: string): ParsedTemplate {
  if (!template.includes('{') && !template.includes('}')) return [template];
  const parts: string[] = [];
  let literal = '';
  let index = 0;
  const length = template.length;
  while (index < length) {
    const char = template[index];
    if (char === '{') {
      if (template[index + 1] === '{') {
        literal += '{';
        index += 2;
        continue;
      }
      const close = template.indexOf('}', index + 1);
      if (close === -1) {
        literal += template.slice(index);
        break;
      }
      const name = template.slice(index + 1, close);
      if (name === '' || name.includes('{')) {
        literal += '{';
        index += 1;
        continue;
      }
      parts.push(literal, name);
      literal = '';
      index = close + 1;
      continue;
    }
    if (char === '}') {
      literal += '}';
      index += template[index + 1] === '}' ? 2 : 1;
      continue;
    }
    literal += char;
    index += 1;
  }
  parts.push(literal);
  return parts;
}

/** The placeholder names a template uses, in order, without repeats. */
export function placeholderNames(template: string): readonly string[] {
  const parts = parseTemplate(template);
  const names: string[] = [];
  for (let index = 1; index < parts.length; index += 2) {
    const name = parts[index];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Renders a template. A placeholder with no value (absent or `undefined`) stays `{name}`. */
export function renderTemplate(template: string, fields: Fields): string {
  return renderParsed(parseTemplate(template), fields);
}

/** Renders an already parsed template. */
export function renderParsed(parts: ParsedTemplate, fields: Fields): string {
  if (parts.length === 1) return parts[0] ?? '';
  let out = parts[0] ?? '';
  for (let index = 1; index < parts.length; index += 2) {
    const name = parts[index] ?? '';
    const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
    out += value === undefined ? `{${name}}` : formatValue(value);
    out += parts[index + 1] ?? '';
  }
  return out;
}
