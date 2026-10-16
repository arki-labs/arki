// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes
// targets. One call per feature; the unit tests cover the details. It uses a
// hand-written schema, so it needs no validator library.

import {
  formatIssues,
  hasJsonSchema,
  isStandardSchema,
  parse,
  parseAsync,
  pathOf,
  SchemaError,
  SchemaRunError,
  withJsonSchema,
} from '../dist/index.js';

/** Accepts a string and returns its length. */
const lengthOf = {
  '~standard': {
    version: 1,
    vendor: 'smoke',
    validate: value =>
      typeof value === 'string'
        ? { value: value.length }
        : { issues: [{ message: 'expected a string', path: [{ key: 'user' }, 'name'] }] },
  },
};
const asyncSchema = { '~standard': { version: 1, vendor: 'later', validate: () => Promise.resolve({ value: 1 }) } };
const bug = new Error('validator bug');
const throwing = {
  '~standard': {
    version: 1,
    vendor: 'buggy',
    validate: () => {
      throw bug;
    },
  },
};

/** The value `fn` throws. */
function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function main() {
  const invalid = thrownBy(() => parse(lengthOf, 1));
  const asyncError = thrownBy(() => parse(asyncSchema, 1));
  const threw = thrownBy(() => parse(throwing, 1));
  const rejected = await parseAsync(throwing, 1).then(
    () => undefined,
    error => error,
  );
  const wrapped = withJsonSchema(lengthOf, { type: 'string' });
  const target = thrownBy(() => wrapped['~standard'].jsonSchema.input({ target: 'draft-07' }));

  const checks = [
    ['parse returns the output', parse(lengthOf, 'abc'), 3],
    ['parseAsync awaits an async schema', await parseAsync(asyncSchema, 1), 1],
    ['bad data is a SchemaError', invalid instanceof SchemaError && invalid.issues.length, 1],
    [
      'SchemaError message is formatted',
      invalid instanceof SchemaError && invalid.message,
      'user.name: expected a string',
    ],
    ['async schema in parse is E001', asyncError instanceof SchemaRunError && asyncError.code, 'ARKI_SCHEMA_E001'],
    ['a throwing validator is E002', threw instanceof SchemaRunError && threw.code, 'ARKI_SCHEMA_E002'],
    ['E002 keeps the cause', threw instanceof SchemaRunError && threw.cause, bug],
    ['parseAsync rejects with E002 and the cause', rejected instanceof SchemaRunError && rejected.cause, bug],
    ['pathOf unwraps { key }', pathOf({ message: 'x', path: [{ key: 'a' }, 0] }).join('.'), 'a.0'],
    ['formatIssues joins issues', formatIssues([{ message: 'm' }, { message: 'n', path: ['p'] }]), 'm; p: n'],
    ['isStandardSchema accepts a schema', isStandardSchema(lengthOf), true],
    ['isStandardSchema rejects an object', isStandardSchema({}), false],
    ['hasJsonSchema is false before wrapping', hasJsonSchema(lengthOf), false],
    ['hasJsonSchema is true after wrapping', hasJsonSchema(wrapped), true],
    ['withJsonSchema still validates', parse(wrapped, 'ab'), 2],
    ['withJsonSchema refuses draft-07 with E003', target instanceof SchemaRunError && target.code, 'ARKI_SCHEMA_E003'],
  ];

  let failedChecks = 0;
  for (const [name, actual, expected] of checks) {
    if (actual === expected) continue;
    failedChecks++;
    console.log(`FAIL ${name}: expected ${String(expected)}, got ${String(actual)}`);
  }
  const runtime =
    typeof HermesInternal !== 'undefined'
      ? 'hermes'
      : typeof Deno !== 'undefined'
        ? 'deno'
        : typeof Bun !== 'undefined'
          ? 'bun'
          : typeof window !== 'undefined'
            ? 'browser'
            : 'node';
  if (failedChecks > 0) {
    console.log(`${runtime}: ${failedChecks} smoke checks FAILED`);
    throw new Error('smoke failed');
  }
  console.log(`${runtime}: ${checks.length} smoke checks passed`);
}

main();
