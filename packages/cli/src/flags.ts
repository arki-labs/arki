/**
 * The flags of a command, read from its input schema's JSON Schema. One
 * `FlagSpec` per top-level property: the property is the camelCase key, the
 * flag its kebab-case form. Validation stays with the schema; this file only
 * says how argv maps onto the keys. The global flags every command takes
 * live here too, so a schema key that collides with one is caught in one place.
 */
import type { SchemaWithJson } from '@arki/schema';

export type FlagKind = 'boolean' | 'integer' | 'number' | 'string';

export type FlagSpec = {
  /** The input key, camelCase, as the schema names it. */
  readonly key: string;
  /** The flag without dashes, kebab-case: `max-batches`. */
  readonly flag: string;
  /** A one-letter alias without the dash (`o` for `-o`). Only global flags have one. */
  readonly short: string | undefined;
  /** How a raw string is coerced; for an array, the kind of each item. */
  readonly kind: FlagKind;
  /** Repeated flag or comma list. */
  readonly array: boolean;
  /** The allowed values, from a JSON Schema `enum`. */
  readonly choices: readonly string[] | undefined;
  /** Required by the schema and without a default. */
  readonly required: boolean;
  /** The schema's default, for help only: defaults are applied by validation, not by the parser. */
  readonly defaultValue: unknown;
  /** The index among the command's `args`; undefined for a flag-only key. */
  readonly position: number | undefined;
  /** A positional array that takes every remaining argument. Only the last one. */
  readonly variadic: boolean;
  /** The schema's `description` (Zod `.describe()`): help text. */
  readonly description: string | undefined;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `maxBatches` → `max-batches`. */
export function kebabCase(key: string): string {
  return key.replaceAll(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

/** The first JSON Schema `type` that is not `null`, or undefined. */
function typeOf(schema: Readonly<Record<string, unknown>>): string | undefined {
  const type = schema['type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.find((entry): entry is string => typeof entry === 'string' && entry !== 'null');
  return undefined;
}

function kindOf(schema: Readonly<Record<string, unknown>>): FlagKind {
  const type = typeOf(schema);
  if (type === 'boolean' || type === 'integer' || type === 'number') return type;
  return 'string';
}

function choicesOf(schema: Readonly<Record<string, unknown>>): readonly string[] | undefined {
  const values = schema['enum'];
  if (!Array.isArray(values)) return undefined;
  return values.map(String);
}

type GlobalOptions = Partial<Pick<FlagSpec, 'short' | 'choices' | 'description'>>;

function globalFlag(key: string, kind: FlagKind, options: GlobalOptions = {}): FlagSpec {
  return {
    key,
    flag: kebabCase(key),
    short: options.short,
    kind,
    array: false,
    choices: options.choices,
    required: false,
    defaultValue: undefined,
    position: undefined,
    variadic: false,
    description: options.description,
  };
}

/** The output modes `-o` takes. `auto` is json when stdout is not a terminal, else text. */
export const OUTPUT_CHOICES = ['auto', 'text', 'json', 'ndjson'] as const;

/** The flags every command takes. Their keys and flags are reserved: an input schema may not use them. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  globalFlag('output', 'string', { short: 'o', choices: OUTPUT_CHOICES, description: 'Output mode' }),
  globalFlag('json', 'boolean', { description: 'Same as -o json' }),
  globalFlag('fields', 'string', { description: 'Keep only these dot paths of the result: a,b.c' }),
  globalFlag('inputJson', 'string', { description: 'The whole input as a JSON object, instead of flags' }),
  globalFlag('inputFile', 'string', { description: 'Read the input JSON from a file, or - for stdin' }),
  globalFlag('quiet', 'boolean', { short: 'q', description: 'No info or warnings on stderr' }),
  globalFlag('color', 'boolean', { description: 'Use --no-color to turn colors off' }),
  globalFlag('dryRun', 'boolean', { description: 'Show what would change, change nothing' }),
  globalFlag('help', 'boolean', { short: 'h', description: 'Show help' }),
  globalFlag('version', 'boolean', { description: 'Show the version' }),
];

const RESERVED = new Set(GLOBAL_FLAGS.flatMap(spec => [spec.key, spec.flag]));

/** True when a spec's key or flag is a global one. */
export function isGlobal(spec: FlagSpec): boolean {
  return GLOBAL_FLAGS.includes(spec);
}

/**
 * One `FlagSpec` per property of the schema's JSON Schema input. `args` names
 * the positionals in order; an array may only be the last one. A schema that
 * is not an object, `args` that name a missing key, or a key that collides
 * with a global flag is a programming error and throws.
 */
export function flagsOf(schema: SchemaWithJson, args: readonly string[] = []): readonly FlagSpec[] {
  const json = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
  if (typeOf(json) !== 'object' || !isRecord(json['properties'])) {
    throw new TypeError('A command input must be an object schema.');
  }
  const properties = json['properties'];
  const required = new Set(Array.isArray(json['required']) ? json['required'].map(String) : []);
  for (const key of args) {
    if (!(key in properties)) throw new TypeError(`args names "${key}", which is not a key of the input.`);
  }
  return Object.entries(properties).map(([key, value]): FlagSpec => {
    const flag = kebabCase(key);
    if (RESERVED.has(key) || RESERVED.has(flag)) {
      throw new TypeError(`The input key "${key}" collides with the global flag --${flag}; rename the key.`);
    }
    const property = isRecord(value) ? value : {};
    const array = typeOf(property) === 'array';
    const item = array && isRecord(property['items']) ? property['items'] : property;
    const index = args.indexOf(key);
    const position = index === -1 ? undefined : index;
    if (array && position !== undefined && position !== args.length - 1) {
      throw new TypeError(`args: the array "${key}" must be the last positional.`);
    }
    return {
      key,
      flag,
      short: undefined,
      kind: kindOf(item),
      array,
      choices: choicesOf(item),
      required: required.has(key) && !('default' in property),
      defaultValue: property['default'],
      position,
      variadic: array && position !== undefined,
      description: typeof property['description'] === 'string' ? property['description'] : undefined,
    };
  });
}
