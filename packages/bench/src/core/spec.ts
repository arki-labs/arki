/**
 * Declaring a suite: identity helpers that give each group its `kind` and
 * per-case type inference, validation that reports every problem at once, and
 * a stable hash of what the suite measures (CI matches baselines by it).
 */
import type {
  CaseBuilder,
  CaseSpec,
  CompareDefinition,
  CompareSpec,
  GroupSpec,
  MetricSpec,
  ScenarioCaseBuilder,
  ScenarioCaseSpec,
  ScenarioDefinition,
  ScenarioSpec,
  SizeSpec,
  SuiteSpec,
} from './types.js';

/** A suite that cannot run as declared. `problems` lists every problem found, not just the first. */
export class SpecError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      problems.length === 1
        ? `Invalid benchmark suite: ${problems[0]}`
        : `Invalid benchmark suite (${problems.length} problems):\n${problems.map(problem => `  - ${problem}`).join('\n')}`,
    );
    this.name = 'SpecError';
    this.problems = problems;
  }
}

/** Group ids, case keys and contract ids: lower-case, start with a letter or digit, then `a-z 0-9 . / -`. */
// Group ids and case keys: plain object keys (camelCase included), plus '.', '/' and '-' for namespaced ids.
export const ID_PATTERN = /^[\da-z][\w./-]*$/i;

/** Suite ids: an id, optionally behind an npm scope (`@arki/money`). Never contains `>` or spaces. */
export const SUITE_ID_PATTERN = /^(?:@[\da-z][\w.-]*\/)?[\da-z][\w./-]*$/i;

export function defineSuite(spec: SuiteSpec): SuiteSpec {
  return spec;
}

const buildCase = <Input, State, Result>(spec: CaseSpec<Input, State, Result>): CaseSpec<Input, unknown, unknown> =>
  spec;

const buildScenarioCase = <Input, State, Result>(
  spec: ScenarioCaseSpec<Input, State, Result>,
): ScenarioCaseSpec<Input, unknown, unknown> => spec;

/**
 * A ranked comparison under an executable contract. Write `cases` as a
 * function to type each case precisely:
 *
 * ```ts
 * compare({
 *   inputs: [1.005, 2.5],
 *   cases: c => ({
 *     arki: c({ setup: n => Money.of(n), run: m => m.round(2), normalize: m => m.toString() }),
 *   }),
 * })
 * ```
 */
export function compare<Input>(spec: CompareDefinition<Input>): CompareSpec<unknown> {
  const cases = typeof spec.cases === 'function' ? spec.cases(buildCase satisfies CaseBuilder<Input>) : spec.cases;
  return { ...spec, kind: 'compare', cases };
}

/** Independent measurements of different work: shown side by side, never ranked. */
export function scenario<Input = undefined>(spec: ScenarioDefinition<Input>): ScenarioSpec<unknown> {
  const cases =
    typeof spec.cases === 'function' ? spec.cases(buildScenarioCase satisfies ScenarioCaseBuilder<Input>) : spec.cases;
  return { ...spec, kind: 'scenario', cases };
}

/** Bundle cost of what a consumer imports (measured by the Node host). */
export function size(spec: Omit<SizeSpec, 'kind'> & { kind?: 'size' }): SizeSpec {
  return { ...spec, kind: 'size' };
}

/** A custom deterministic or measured metric. */
export function metric(spec: Omit<MetricSpec, 'kind'> & { kind?: 'metric' }): MetricSpec {
  return { ...spec, kind: 'metric' };
}

const SIZE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
};

/**
 * Parses a size budget such as `'8 kB'`, `'1.5MB'`, `'512 B'` or `'10 KiB'`
 * into bytes. kB/MB are decimal (1000), KiB/MiB binary (1024); unit case is
 * ignored. Returns undefined when the string does not parse.
 */
export function parseSize(limit: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(limit);
  if (!match) return undefined;
  const factor = SIZE_UNITS[match[2]!.toLowerCase()];
  if (factor === undefined) return undefined;
  return Math.round(Number(match[1]) * factor);
}

function checkId(problems: string[], what: string, id: string, pattern = ID_PATTERN): void {
  if (!pattern.test(id))
    problems.push(
      `${what} "${id}" is not a valid id (use letters, digits, '.', '_', '/' or '-', starting with a letter or digit).`,
    );
}

type BaselineCase = { differs?: string; variant?: boolean };

function checkBaseline(
  problems: string[],
  where: string,
  baseline: string | undefined,
  cases: Readonly<Record<string, BaselineCase>>,
): void {
  if (!baseline) {
    problems.push(`${where} has no baseline; set \`baseline\` to the key of the reference case.`);
    return;
  }
  const base = cases[baseline];
  if (!base) {
    const keys = Object.keys(cases);
    problems.push(
      `${where}: baseline "${baseline}" is not one of its cases (${keys.map(key => `"${key}"`).join(', ') || 'none'}).`,
    );
    return;
  }
  if (base.differs !== undefined) problems.push(`${where}: the baseline "${baseline}" cannot be marked \`differs\`.`);
  if (base.variant) problems.push(`${where}: the baseline "${baseline}" cannot be marked \`variant\`.`);
}

function validateGroup(problems: string[], group: GroupSpec): void {
  const where = `Group "${group.id}"`;
  const keys = Object.keys(group.cases);
  if (keys.length === 0) problems.push(`${where} has no cases.`);
  for (const key of keys) checkId(problems, `${where}: case key`, key);

  switch (group.kind) {
    case 'scenario': {
      if (group.inputs?.length === 0) problems.push(`${where}: \`inputs\` is empty; omit it or give at least one.`);
      break;
    }
    case 'size': {
      checkBaseline(problems, where, group.baseline, group.cases);
      for (const [key, sizeCase] of Object.entries(group.cases)) {
        if (sizeCase.limit !== undefined && parseSize(sizeCase.limit) === undefined) {
          problems.push(`${where}, case "${key}": limit "${sizeCase.limit}" does not parse (e.g. '8 kB', '512 B').`);
        }
      }
      break;
    }
    case 'metric': {
      checkBaseline(problems, where, group.baseline, group.cases);
      break;
    }
    default: {
      // 'compare' (kind is optional on CompareSpec)
      checkBaseline(problems, where, group.baseline, group.cases);
      checkId(problems, `${where}: contract id`, group.contract.id);
      if (group.inputs.length === 0) {
        problems.push(`${where}: \`inputs\` is empty; the contract check and timing need at least one input.`);
      }
      const rankable = keys.filter(key => group.cases[key]!.differs === undefined);
      if (rankable.length < 2) {
        problems.push(
          `${where} has ${rankable.length} case(s) that keep the contract; a comparison needs at least two. Use scenario() for unranked measurements.`,
        );
      }
    }
  }
}

/** Throws a {@link SpecError} listing every problem in the suite. */
export function validateSuite(spec: SuiteSpec): void {
  const problems: string[] = [];
  if (spec.id) checkId(problems, 'Suite id', spec.id, SUITE_ID_PATTERN);
  else problems.push('The suite has no id.');
  if (spec.groups.length === 0) problems.push('The suite has no groups.');
  const seen = new Set<string>();
  for (const group of spec.groups) {
    checkId(problems, 'Group id', group.id);
    if (seen.has(group.id)) problems.push(`Group id "${group.id}" is used more than once.`);
    seen.add(group.id);
    validateGroup(problems, group);
  }
  if (problems.length > 0) throw new SpecError(problems);
}

// ---------------------------------------------------------------------------
// specHash
// ---------------------------------------------------------------------------

function constructorName(value: object): string {
  const constructor: unknown = Reflect.get(value, 'constructor');
  return typeof constructor === 'function' ? constructor.name : '';
}

function bytesHex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

/**
 * Unambiguous, type-tagged encoding of a declared value (inputs). Every
 * token says its type, so `1n` and the string "1n", `undefined` and any
 * marker string, a Date and its ISO string, -0 and 0, NaN and "NaN" all
 * differ. Plain-object keys are sorted (key order does not count) and read
 * as data, never assigned, so `__proto__` is an ordinary key. Map and Set
 * keep their insertion order. A cycle becomes a back-reference to the
 * ancestor it points at. Functions encode as a bare tag: their source
 * differs per runtime and is never hashed.
 */
export function encodeValue(value: unknown, stack: object[] = []): string {
  switch (typeof value) {
    case 'undefined': {
      return 'u';
    }
    case 'boolean': {
      return value ? 'T' : 'F';
    }
    case 'number': {
      return `n${Object.is(value, -0) ? '-0' : String(value)}`;
    }
    case 'bigint': {
      return `i${value}`;
    }
    case 'string': {
      return `s${JSON.stringify(value)}`;
    }
    case 'symbol': {
      return `y${JSON.stringify(value.description ?? '')}`;
    }
    case 'function': {
      return 'f';
    }
    default: {
      break;
    }
  }
  if (typeof value !== 'object' || value === null) return 'z';
  const ancestor = stack.indexOf(value);
  if (ancestor !== -1) return `c${stack.length - ancestor}`;
  stack.push(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      // for-of, not map: holes encode as undefined instead of disappearing.
      for (const item of value) items.push(encodeValue(item, stack));
      return `A[${items.join(',')}]`;
    }
    if (value instanceof Date) return `D${value.getTime()}`;
    if (value instanceof RegExp) return `R${JSON.stringify(value.source)}${value.flags}`;
    if (value instanceof Map) {
      return `M[${[...value].map(([key, item]) => `${encodeValue(key, stack)}=>${encodeValue(item, stack)}`).join(',')}]`;
    }
    if (value instanceof Set) return `S[${[...value].map(item => encodeValue(item, stack)).join(',')}]`;
    if (value instanceof ArrayBuffer) return `B[${bytesHex(new Uint8Array(value))}]`;
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return `V${JSON.stringify(constructorName(value))}[${bytesHex(bytes)}]`;
    }
    if (value instanceof Error) return `E${JSON.stringify(value.name)}${JSON.stringify(value.message)}`;
    const prototype: unknown = Object.getPrototypeOf(value);
    const tag =
      prototype === null || prototype === Object.prototype ? 'O' : `I${JSON.stringify(constructorName(value))}`;
    const fields = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${encodeValue(Reflect.get(value, key), stack)}`);
    return `${tag}{${fields.join(',')}}`;
  } finally {
    stack.pop();
  }
}

/** Inputs as one encoded string (`null` when a scenario declares none). */
function inputsData(inputs: readonly unknown[] | undefined): string | null {
  return inputs === undefined ? null : encodeValue(inputs);
}

type CaseData = { label?: string; package?: string; differs?: string; variant?: boolean };

const caseData = (key: string, spec: CaseData): unknown => [
  key,
  spec.label ?? null,
  spec.package ?? null,
  spec.differs ?? null,
  spec.variant ?? false,
];

function sortedEntries<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function groupData(group: GroupSpec): unknown {
  const common = { id: group.id, title: group.title };
  switch (group.kind) {
    case 'size': {
      return {
        ...common,
        kind: 'size',
        baseline: group.baseline,
        externals: group.externals ?? null,
        cases: sortedEntries(group.cases).map(([key, c]) => [
          caseData(key, c),
          c.source,
          c.ext ?? 'js',
          c.limit ?? null,
        ]),
      };
    }
    case 'metric': {
      return {
        ...common,
        kind: 'metric',
        unit: group.unit,
        deterministic: group.deterministic,
        baseline: group.baseline,
        cases: sortedEntries(group.cases).map(([key, c]) => caseData(key, c)),
      };
    }
    case 'scenario': {
      return {
        ...common,
        kind: 'scenario',
        mode: group.mode ?? 'sync',
        inputs: inputsData(group.inputs),
        cases: sortedEntries(group.cases).map(([key, c]) => caseData(key, c)),
      };
    }
    default: {
      return {
        ...common,
        kind: 'compare',
        contract: { id: group.contract.id, description: group.contract.description },
        baseline: group.baseline,
        mode: group.mode ?? 'sync',
        inputs: inputsData(group.inputs),
        cases: sortedEntries(group.cases).map(([key, c]) => caseData(key, c)),
      };
    }
  }
}

const hex = (value: number): string => value.toString(16).padStart(8, '0');

const SPEED_UNIT = 'ns/op';

/** FNV-1a over UTF-16 code units, 32-bit, from a given offset basis. */
function fnv1a(text: string, basis: number): number {
  let hash = basis >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16_777_619 /* FNV prime 0x01000193 */) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Stable 64-bit hash (two independent 32-bit FNV-1a lanes, 16 hex chars) of
 * what the suite DECLARES: suite id; per group its id, kind, title, contract
 * id and description, baseline, mode, inputs (type-tagged encoding), case keys,
 * labels, packages, differs and variant flags; size sources, externals,
 * extensions and limits; metric unit and determinism. Case order does not
 * count. Portable: no crypto.
 *
 * Function source (setup/run/normalize/expected/collect) is deliberately NOT
 * hashed: Node, Bun and Deno print it differently (Bun transpiles
 * TypeScript), so the same suite would hash three ways. The contract id is
 * the explicit "the work changed" signal: bump it (e.g. `money-add/v1` →
 * `money-add/v2`) when the measured work changes. A code-only change to
 * `run()` keeps old baselines compatible on purpose, so CI can catch the
 * regression it causes.
 */
export function specHash(spec: SuiteSpec): string {
  return hash64(JSON.stringify({ id: spec.id, groups: spec.groups.map(group => groupData(group)) }));
}

function hash64(text: string): string {
  // Lane 1: the FNV offset basis 0x811C9DC5. Lane 2: an unrelated basis (golden-ratio constant 0x9E3779B9).
  return hex(fnv1a(text, 2_166_136_261)) + hex(fnv1a(text, 2_654_435_769));
}

/** What changes the measured work of one case, and nothing else. */
function workData(group: GroupSpec, key: string): unknown {
  switch (group.kind) {
    case 'size': {
      const entry = group.cases[key];
      return [
        'size',
        'bytes',
        group.externals ?? null,
        key,
        entry?.source ?? null,
        entry?.ext ?? 'js',
        entry?.differs ?? null,
        entry?.variant ?? false,
      ];
    }
    case 'metric': {
      return ['metric', group.unit, key, group.cases[key]?.differs ?? null];
    }
    case 'scenario': {
      return ['scenario', SPEED_UNIT, group.mode ?? 'sync', inputsData(group.inputs), key];
    }
    default: {
      const entry = group.cases[key];
      return [
        'compare',
        SPEED_UNIT,
        group.contract.id,
        group.mode ?? 'sync',
        inputsData(group.inputs),
        key,
        entry?.differs ?? null,
        entry?.variant ?? false,
      ];
    }
  }
}

/**
 * Stable hash of the work one case measures: group kind, contract id, mode,
 * inputs, unit, externals, and the case's own key, source/ext (size),
 * `differs` and `variant`. Labels, titles, notes, packages, limits and the
 * OTHER cases do not affect it, so adding a competitor or renaming a label
 * keeps every existing baseline comparable. Like `specHash`, function source
 * is never hashed: bump the contract id when the work changes.
 */
export function workHash(group: GroupSpec, key: string): string {
  return hash64(JSON.stringify(workData(group, key)));
}
