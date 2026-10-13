// Type-check cost of the @arki/ts helpers against type-fest and ts-essentials.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// @arki/ts has no runtime code, so this measures what its types cost the
// compiler. For each helper, a fixture applies the helper to generated input
// types. Before counting, a separate program checks that every library's result
// is equivalent to a hand-written expected type: assignable both ways, and not
// `any`, `unknown` or `never`. A mismatch stops the run. The count is the number
// of type instantiations the checker creates for the fixture, minus the count
// for an empty file: deterministic for one TypeScript version. Fixtures live in
// memory; nothing is written to disk.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { defineSuite, metric } from '@arki/bench';

// A virtual file inside the package, so `@arki/ts/*` resolves through the
// package's own exports map (the built `dist/` types) and competitors through node_modules.
const FIXTURE = path.join(fileURLToPath(new URL('.', import.meta.url)), '__fixture__.ts');

const options: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
};

const COPIES = [...'abcde'];
const WORDS = ['red', 'green', 'blue'];
const LEVELS = ['one', 'two', 'three', 'four'];
const LEAVES = ['string', 'number', 'boolean'];

// ---- input and expected-type generators ----------------------------------------------------

type KeyName = (level: number, index: number) => string;

const cap = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const snake =
  (tag: string): KeyName =>
  (level, index) =>
    `${WORDS[index]}_${LEVELS[level]}_${tag}`;
const camel =
  (tag: string): KeyName =>
  (level, index) =>
    `${WORDS[index]}${cap(LEVELS[level] ?? '')}${cap(tag)}`;
const optional = (name: string): string => `${name}?`;

/** A tree of nested object types: three properties per level, primitive leaves. */
function tree(depth: number, key: KeyName, wrap: (name: string) => string = name => name, level = 0): string {
  const members = WORDS.map((_, index) => {
    const value = level === depth - 1 ? LEAVES[index] : tree(depth, key, wrap, level + 1);
    return `${wrap(key(level, index))}: ${value}`;
  });
  return `{ ${members.join('; ')} }`;
}

/** Every dotted path of a tree, intermediate nodes included. */
function paths(depth: number, tag: string, level = 0, prefix = ''): string[] {
  return WORDS.flatMap((_, index) => {
    const path = `${prefix}${snake(tag)(level, index)}`;
    return level < depth - 1 ? [`'${path}'`, ...paths(depth, tag, level + 1, `${path}.`)] : [`'${path}'`];
  });
}

function flat(tag: string): Fixture {
  const groups = ['p', 'q', 'r', 's'].map(word => LEAVES.map((leaf, index) => `${word}_${index}_${tag}: ${leaf}`));
  return {
    input: groups.map(members => `{ ${members.join('; ')} }`).join(' & '),
    expected: `{ ${groups.flat().join('; ')} }`,
  };
}

// ---- groups ---------------------------------------------------------------------------------

type Fixture = { input: string; expected: string; path?: string };
type HelperCase = {
  label: string;
  package: string;
  importLine: string;
  apply: (input: string, path: string) => string;
};
type HelperGroup = {
  id: string;
  title: string;
  note: string;
  copies: number;
  make: (tag: string) => Fixture;
  /** The result must be one object type, not an intersection (what Prettify promises beyond equivalence). */
  flattened?: boolean;
  cases: Record<'arki' | 'typeFest' | 'tsEssentials', HelperCase>;
};

const helperGroups: HelperGroup[] = [
  {
    id: 'prettify',
    title: 'Flatten an intersection (Prettify)',
    note: 'Forty intersections of four object types, flattened into one object type. Checked: equivalent to the hand-written object and not an intersection.',
    copies: 40,
    make: flat,
    flattened: true,
    cases: {
      arki: {
        label: '@arki/ts Prettify',
        package: '@arki/ts',
        importLine: "import type { Prettify } from '@arki/ts/prettify';",
        apply: input => `Prettify<${input}>`,
      },
      typeFest: {
        label: 'type-fest Simplify',
        package: 'type-fest',
        importLine: "import type { Simplify } from 'type-fest';",
        apply: input => `Simplify<${input}>`,
      },
      tsEssentials: {
        label: 'ts-essentials Prettify',
        package: 'ts-essentials',
        importLine: "import type { Prettify } from 'ts-essentials';",
        apply: input => `Prettify<${input}>`,
      },
    },
  },
  {
    id: 'deep-partial',
    title: 'Make every property optional, deeply (DeepPartial)',
    note: 'Five object types, four levels deep, three properties per level.',
    copies: 5,
    make: tag => ({ input: tree(4, snake(tag)), expected: tree(4, snake(tag), optional) }),
    cases: {
      arki: {
        label: '@arki/ts DeepPartial',
        package: '@arki/ts',
        importLine: "import type { DeepPartial } from '@arki/ts/utils';",
        apply: input => `DeepPartial<${input}>`,
      },
      typeFest: {
        label: 'type-fest PartialDeep',
        package: 'type-fest',
        importLine: "import type { PartialDeep } from 'type-fest';",
        apply: input => `PartialDeep<${input}>`,
      },
      tsEssentials: {
        label: 'ts-essentials DeepPartial',
        package: 'ts-essentials',
        importLine: "import type { DeepPartial } from 'ts-essentials';",
        apply: input => `DeepPartial<${input}>`,
      },
    },
  },
  {
    id: 'snake-to-camel',
    title: 'Rename snake_case keys to camelCase, deeply',
    note: 'Five object types, four levels deep, three properties per level.',
    copies: 5,
    make: tag => ({ input: tree(4, snake(tag)), expected: tree(4, camel(tag)) }),
    cases: {
      arki: {
        label: '@arki/ts DeepSnakeToCamel',
        package: '@arki/ts',
        importLine: "import type { DeepSnakeToCamel } from '@arki/ts/utils';",
        apply: input => `DeepSnakeToCamel<${input}>`,
      },
      typeFest: {
        label: 'type-fest CamelCasedPropertiesDeep',
        package: 'type-fest',
        importLine: "import type { CamelCasedPropertiesDeep } from 'type-fest';",
        apply: input => `CamelCasedPropertiesDeep<${input}>`,
      },
      tsEssentials: {
        label: 'ts-essentials DeepCamelCaseProperties',
        package: 'ts-essentials',
        importLine: "import type { DeepCamelCaseProperties } from 'ts-essentials';",
        apply: input => `DeepCamelCaseProperties<${input}>`,
      },
    },
  },
  {
    id: 'paths',
    title: 'List every dotted property path',
    note: 'Five object types, three levels deep, three properties per level (39 paths each).',
    copies: 5,
    make: tag => ({ input: tree(3, snake(tag)), expected: paths(3, tag).join(' | ') }),
    cases: {
      arki: {
        label: '@arki/ts RecordToPath',
        package: '@arki/ts',
        importLine: "import type { RecordToPath } from '@arki/ts/utils';",
        apply: input => `RecordToPath<${input}>`,
      },
      typeFest: {
        label: 'type-fest Paths',
        package: 'type-fest',
        importLine: "import type { Paths } from 'type-fest';",
        apply: input => `Paths<${input}>`,
      },
      tsEssentials: {
        label: 'ts-essentials Paths',
        package: 'ts-essentials',
        importLine: "import type { Paths } from 'ts-essentials';",
        apply: input => `Paths<${input}>`,
      },
    },
  },
  {
    id: 'path-value',
    title: 'Read the type at a dotted path',
    note: 'Five object types, three levels deep; each read asks for the first leaf.',
    copies: 5,
    make: tag => ({
      input: tree(3, snake(tag)),
      expected: 'string',
      path: [0, 1, 2].map(level => snake(tag)(level, 0)).join('.'),
    }),
    cases: {
      arki: {
        label: '@arki/ts PathValue',
        package: '@arki/ts',
        importLine: "import type { PathValue } from '@arki/ts/utils';",
        apply: (input, path) => `PathValue<${input}, '${path}'>`,
      },
      typeFest: {
        label: 'type-fest Get',
        package: 'type-fest',
        importLine: "import type { Get } from 'type-fest';",
        apply: (input, path) => `Get<${input}, '${path}'>`,
      },
      tsEssentials: {
        label: 'ts-essentials PathValue',
        package: 'ts-essentials',
        importLine: "import type { PathValue } from 'ts-essentials';",
        apply: (input, path) => `PathValue<${input}, '${path}'>`,
      },
    },
  },
];

// ---- fixtures and the compiler ----------------------------------------------------------------

/**
 * One fixture per (group, library). `I{n}` is the input, `E{n}` the expected type, `r{n}` the
 * helper's result. The measured form assigns `r{n}` to `E{n}`, which makes the checker resolve the
 * whole result; the check form declares both so the script can compare them both ways.
 */
function fixture(group: HelperGroup, helper: HelperCase, form: 'measure' | 'check'): string {
  const lines = [helper.importLine];
  for (let n = 0; n < group.copies; n++) {
    const tag = group.copies > COPIES.length ? `t${n}` : (COPIES[n] ?? `t${n}`);
    const { input, expected, path = '' } = group.make(tag);
    lines.push(
      `type I${n} = ${input};`,
      `type E${n} = ${expected};`,
      `declare const r${n}: ${helper.apply(`I${n}`, path)};`,
      form === 'measure' ? `export const c${n}: E${n} = r${n};` : `export declare const e${n}: E${n};`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function compile(source: string, label: string): { program: ts.Program; file: ts.SourceFile } {
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, language, onError, shouldCreate) =>
    fileName === FIXTURE
      ? ts.createSourceFile(fileName, source, language, true)
      : getSourceFile(fileName, language, onError, shouldCreate);
  host.fileExists = fileName => fileName === FIXTURE || fileExists(fileName);
  host.readFile = fileName => (fileName === FIXTURE ? source : readFile(fileName));
  const program = ts.createProgram([FIXTURE], options, host);
  const file = program.getSourceFile(FIXTURE);
  if (!file) throw new Error(`${label}: the fixture did not load`);
  const diagnostics = program.getSemanticDiagnostics(file);
  const first = diagnostics[0];
  if (first) {
    const text = ts.flattenDiagnosticMessageText(first.messageText, '\n').slice(0, 600);
    throw new Error(`${label}: ${diagnostics.length} type error(s), first: ${text}`);
  }
  return { program, file };
}

const REJECTED = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;

/** Throws unless every result is assignable to its expected type and back, and is not any/unknown/never. */
function checkEquivalence(group: HelperGroup, helper: HelperCase, label: string): void {
  const { program, file } = compile(fixture(group, helper, 'check'), label);
  const checker = program.getTypeChecker();
  const declared = new Map<string, ts.Type>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      declared.set(declaration.name.getText(file), checker.getTypeAtLocation(declaration.name));
    }
  }
  for (let n = 0; n < group.copies; n++) {
    const result = declared.get(`r${n}`);
    const expected = declared.get(`e${n}`);
    if (!result || !expected) throw new Error(`${label}: copy ${n} is missing from the check fixture`);
    const shown = checker.typeToString(result);
    const problem =
      (result.flags & REJECTED) === 0
        ? checker.isTypeAssignableTo(result, expected)
          ? checker.isTypeAssignableTo(expected, result)
            ? group.flattened && (result.flags & ts.TypeFlags.Intersection) !== 0
              ? `${shown} is still an intersection`
              : undefined
            : `the expected type is not assignable to ${shown}`
          : `${shown} is not assignable to the expected type`
        : `resolved to ${shown}`;
    if (problem) throw new Error(`${label}, copy ${n}: ${problem}`);
  }
}

function instantiations(source: string, label: string): number {
  return compile(source, label).program.getInstantiationCount();
}

let emptyCount: number | undefined;

function measure(group: HelperGroup, helper: HelperCase): number {
  const label = `${group.title} / ${helper.label}`;
  checkEquivalence(group, helper, label);
  emptyCount ??= instantiations('export {};\n', 'empty file');
  return Math.max(0, instantiations(fixture(group, helper, 'measure'), label) - emptyCount);
}

export default defineSuite({
  id: '@arki/ts',
  intro: `Type-check cost of the helpers in \`@arki/ts\` against their closest equivalents in type-fest and ts-essentials, counted with TypeScript ${ts.version}. The package has no runtime code, so the cost that matters is how much work the compiler does to resolve each helper.`,
  notes: [
    'Before counting, every library’s result is compared with a hand-written expected type: it must be assignable to it and back, and must not be `any`, `unknown` or `never`. The Prettify results must also be one object type, not an intersection. A mismatch stops the run.',
    'The number is type instantiations: how many types the checker creates for the fixture, minus an empty file. It is deterministic for one TypeScript version and machine-independent. Check time (wall clock) is not reported.',
    '@arki/ts helpers are small and cover plain objects and string keys. type-fest and ts-essentials handle more input (arrays, tuples, optional keys, unions of objects, options for how to treat them), which costs extra instantiations. A lower count here is a smaller feature set as much as it is a cheaper type.',
    '`DeepSnakeToCamel` only converts snake_case. type-fest `CamelCasedPropertiesDeep` and ts-essentials `DeepCamelCaseProperties` accept more key styles.',
  ],
  groups: helperGroups.map(group =>
    metric({
      id: group.id,
      title: group.title,
      note: group.note,
      unit: 'instantiations',
      deterministic: true,
      baseline: 'arki',
      cases: Object.fromEntries(
        Object.entries(group.cases).map(([key, helper]) => [
          key,
          { label: helper.label, package: helper.package, collect: () => measure(group, helper) },
        ]),
      ),
    }),
  ),
});
