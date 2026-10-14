/**
 * Languages (RFC §9): the whitelist of callable functions and named constants.
 * Nothing is callable unless the language passed to `parse` registers it. A
 * language holds only names, arities and LaTeX command names, never numeric
 * code; each domain's `compile` supplies the implementations.
 *
 * Tables live in private `Map`s behind frozen lookup functions, so a name like
 * `constructor`, `__proto__` or `toString` is just a name that is not there.
 */
import { InvalidArgumentError } from '@arki/math/errors';

import { isName } from './lexer.js';

export type FunctionSpec = {
  /** Inclusive bounds on the argument count. */
  readonly arity: readonly [min: number, max: number];
  /** LaTeX command for the function name (e.g. `\\sin`); `undefined` means `\\operatorname{name}`. */
  readonly latex: string | undefined;
};

export type ConstantSpec = { readonly latex: string | undefined };

export type FunctionDefinition = {
  /** An exact count, or inclusive `[min, max]`. */
  readonly arity: number | readonly [number, number];
  readonly latex?: string;
};

export type ConstantDefinition = { readonly latex?: string };

export type LanguageDefinition = {
  /** Start from this language. Redefining one of its names is a conflict. */
  readonly extends?: Language;
  readonly functions?: Readonly<Record<string, FunctionDefinition>>;
  readonly constants?: Readonly<Record<string, ConstantDefinition>>;
};

export type Language = {
  readonly functionSpec: (name: string) => FunctionSpec | undefined;
  readonly constantSpec: (name: string) => ConstantSpec | undefined;
  /** Registered function names, sorted. */
  readonly functionNames: () => string[];
  /** Registered constant names, sorted. */
  readonly constantNames: () => string[];
};

const languages = new WeakSet<object>();

/** True when `value` was built by `defineLanguage`. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'object' && value !== null && languages.has(value);
}

function sortedKeys(map: ReadonlyMap<string, unknown>): string[] {
  return [...map.keys()].sort();
}

function isCount(count: unknown): count is number {
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
}

function arityOf(name: string, arity: unknown): readonly [number, number] {
  if (isCount(arity)) return Object.freeze([arity, arity] as const);
  if (Array.isArray(arity) && arity.length === 2) {
    const [min, max]: unknown[] = arity;
    if (isCount(min) && isCount(max) && min <= max) return Object.freeze([min, max] as const);
  }
  throw new InvalidArgumentError(
    `Function "${name}": arity must be a non-negative integer or [min, max] with min <= max`,
  );
}

function latexOf(name: string, definition: unknown): string | undefined {
  if (typeof definition !== 'object' || definition === null) {
    throw new InvalidArgumentError(`"${name}": the definition must be an object`);
  }
  const latex = 'latex' in definition ? definition.latex : undefined;
  if (latex !== undefined && typeof latex !== 'string') {
    throw new InvalidArgumentError(`"${name}": latex must be a string`);
  }
  return latex;
}

/**
 * Builds a language. Names must match the expression `name` grammar (a
 * letter, then letters, digits or `_`); a name defined twice — as a function
 * and a constant, or again on top of `extends` — throws `InvalidArgumentError`.
 */
export function defineLanguage(definition: LanguageDefinition): Language {
  const functions = new Map<string, FunctionSpec>();
  const constants = new Map<string, ConstantSpec>();
  const base = definition.extends;
  if (base !== undefined) {
    if (!isLanguage(base)) throw new InvalidArgumentError('extends must be a language built by defineLanguage');
    for (const name of base.functionNames()) {
      const spec = base.functionSpec(name);
      if (spec !== undefined) functions.set(name, spec);
    }
    for (const name of base.constantNames()) {
      const spec = base.constantSpec(name);
      if (spec !== undefined) constants.set(name, spec);
    }
  }

  const claim = (name: string): void => {
    if (!isName(name)) {
      throw new InvalidArgumentError(`"${name}" is not a valid name: use a letter, then letters, digits or _`);
    }
    if (functions.has(name) || constants.has(name)) {
      throw new InvalidArgumentError(`Name conflict: "${name}" is already defined in this language`);
    }
  };

  const functionTable = definition.functions ?? {};
  for (const name of Object.keys(functionTable)) {
    claim(name);
    const entry: unknown = functionTable[name];
    const latex = latexOf(name, entry);
    const arity = arityOf(
      name,
      typeof entry === 'object' && entry !== null && 'arity' in entry ? entry.arity : undefined,
    );
    functions.set(name, Object.freeze({ arity, latex }));
  }
  const constantTable = definition.constants ?? {};
  for (const name of Object.keys(constantTable)) {
    claim(name);
    constants.set(name, Object.freeze({ latex: latexOf(name, constantTable[name]) }));
  }

  const language: Language = Object.freeze({
    functionSpec: (name: string) => functions.get(name),
    constantSpec: (name: string) => constants.get(name),
    functionNames: () => sortedKeys(functions),
    constantNames: () => sortedKeys(constants),
  });
  languages.add(language);
  return language;
}

const unary = (latex?: string): FunctionDefinition => (latex === undefined ? { arity: 1 } : { arity: 1, latex });

/**
 * The built-in language: trigonometric, inverse, hyperbolic and inverse
 * hyperbolic functions (with the `sec csc cot` families), `exp ln log log10
 * log2 sqrt cbrt nthRoot pow abs sign ceil floor round fix factorial mod`,
 * and the constants `pi`, `e` and `i`. `log(x)` is the natural log;
 * `log(x, b)` takes a base.
 */
export const scientific: Language = defineLanguage({
  functions: {
    sin: unary('\\sin'),
    cos: unary('\\cos'),
    tan: unary('\\tan'),
    sec: unary('\\sec'),
    csc: unary('\\csc'),
    cot: unary('\\cot'),
    asin: unary('\\arcsin'),
    acos: unary('\\arccos'),
    atan: unary('\\arctan'),
    asec: unary(),
    acsc: unary(),
    acot: unary(),
    sinh: unary('\\sinh'),
    cosh: unary('\\cosh'),
    tanh: unary('\\tanh'),
    sech: unary(),
    csch: unary(),
    coth: unary('\\coth'),
    asinh: unary(),
    acosh: unary(),
    atanh: unary(),
    asech: unary(),
    acsch: unary(),
    acoth: unary(),
    exp: unary('\\exp'),
    ln: unary('\\ln'),
    log: { arity: [1, 2], latex: '\\log' },
    log10: unary('\\log_{10}'),
    log2: unary('\\log_{2}'),
    sqrt: unary('\\sqrt'),
    cbrt: unary(),
    nthRoot: { arity: [1, 2] },
    pow: { arity: 2 },
    abs: unary(),
    sign: unary('\\operatorname{sgn}'),
    ceil: unary(),
    floor: unary(),
    round: unary(),
    fix: unary(),
    factorial: unary(),
    mod: { arity: 2 },
  },
  constants: {
    pi: { latex: '\\pi' },
    e: { latex: 'e' },
    i: { latex: 'i' },
  },
});
