// Speed and size of @arki/cas against mathjs (pruned with create() to
// derivative, simplify and rationalize), Algebrite and nerdamer (RFC §14).
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme` on an idle machine.
//
// Every `compare` group is checked before timing. Derivatives and simplified
// forms must have the same values as ours at 5 points (1e-9 relative),
// expansions and coefficients must be exactly equal, and factorizations must
// be the same multiset of factors up to units. A library that fails the check
// on an input is shown as "differs" for that group, never ranked. No cache
// keyed by input and no input-shaped fast paths: cas hash-conses per call and
// rebuilds everything on every call.

import Algebrite from 'algebrite';
import {
  create,
  derivativeDependencies,
  parseDependencies,
  rationalizeDependencies,
  simplifyDependencies,
} from 'mathjs';
import nerdamer from 'nerdamer';

import type { Node } from '@arki/expr';
import { compare, defineSuite, scenario, size } from '@arki/bench';
import { derivation } from '@arki/cas/derivation';
import { derivative } from '@arki/cas/derivative';
import { expand, factor, gcd, polynomialIn } from '@arki/cas/polynomial';
import { simplify } from '@arki/cas/simplify';
import { parse } from '@arki/expr';
import { compile } from '@arki/expr/float';
import { Rational } from '@arki/math/rational';

import fixtures from '../test/reference/fixtures/factor.json' with { type: 'json' };
import { buildNoRecorder } from './no-recorder.js';

const math = create(
  { derivativeDependencies, parseDependencies, rationalizeDependencies, simplifyDependencies },
  { number: 'number' },
);
/** The same pruned set as `math` above, as source for the bundle-size case. */
const MATHJS_DEPENDENCIES = 'derivativeDependencies, parseDependencies, rationalizeDependencies, simplifyDependencies';

function isDerivativeModule(module: unknown): module is { derivative: typeof derivative } {
  return (
    typeof module === 'object' && module !== null && 'derivative' in module && typeof module.derivative === 'function'
  );
}
const noRecorder: unknown = await import(buildNoRecorder().href);
if (!isDerivativeModule(noRecorder)) throw new Error('the no-recorder build exports no derivative');
const derivativeNoRecorder = noRecorder.derivative;

// ---------------------------------------------------------------------------
// Contracts

const XS = [0.3, 0.7, 1.3, 1.9, 2.6] as const;
const Y = 0.6;

/** The values of a printed result at the sample points (y fixed), parsed by @arki/expr. */
function valuesOf(text: string): number[] {
  const f = compile(parse(text), { variables: ['x', 'y'] });
  return XS.map(x => f({ x, y: Y }));
}

/**
 * The 1e-9 contract as a normalization: values that all lie within 1e-9
 * relative of one input's reference become that reference; anything else
 * stays as it is and fails the harness's equality check.
 */
const near =
  (references: readonly (readonly number[])[]) =>
  (values: readonly number[]): readonly number[] =>
    references.find(
      reference =>
        reference.length === values.length &&
        reference.every((r, i) => Math.abs((values[i] ?? Number.NaN) - r) <= 1e-9 * Math.max(1, Math.abs(r))),
    ) ?? values;

/** Ascending coefficients in x, each as cas's canonical text (other names stay in the coefficients). */
function coefficientsOf(text: string): string[] {
  const form = polynomialIn(text, 'x');
  return form.kind === 'polynomial' ? form.coefficients.map(c => c.value.source) : [`not a polynomial: ${form.kind}`];
}

/** A polynomial in x divided by its leading coefficient, so units and content drop out. */
function monic(text: string): string {
  const form = polynomialIn(text, 'x');
  if (form.kind !== 'polynomial') return `not a polynomial: ${text}`;
  const coefficients = form.coefficients.map(c => c.rational);
  const lead = coefficients.at(-1);
  if (lead === undefined || lead === null || coefficients.includes(null)) return `not rational: ${text}`;
  return coefficients.map(c => c?.times(lead.inverse()).toString()).join(' ');
}

/** The factors of a printed product, monic, one entry per multiplicity, sorted; constant factors are units. */
function factorsOf(text: string): string[] {
  const { root, source } = parse(text, { limits: { length: 100_000, tokens: 100_000 } });
  const keys: string[] = [];
  const stack: [Node, number][] = [[root, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, multiplicity] = item;
    if (node.kind === 'group' || node.kind === 'unary')
      stack.push([node.kind === 'group' ? node.inner : node.arg, multiplicity]);
    else if (node.kind === 'binary' && node.op === '*')
      stack.push([node.left, multiplicity], [node.right, multiplicity]);
    else if (node.kind === 'binary' && node.op === '/' && node.right.kind === 'number')
      stack.push([node.left, multiplicity]);
    else if (node.kind === 'binary' && node.op === '^' && node.right.kind === 'number') {
      stack.push([node.left, multiplicity * Number(node.right.raw)]);
    } else if (node.kind !== 'number') {
      const key = monic(source.slice(node.span.start, node.span.end));
      if (key !== '1') keys.push(...Array.from({ length: multiplicity }, () => key));
    }
  }
  return keys.toSorted();
}

/** Rational coefficient lists printed by nerdamer's `coeffs`: `[5/6, 1/6]`. */
function rationalsOf(text: string): string[] {
  return text
    .replaceAll(/[[\]\s]/gu, '')
    .split(',')
    .map(c => Rational.from(c).toString());
}

// ---------------------------------------------------------------------------
// Inputs

/** The derivative calculator's four presets, at order 1. */
const PRESETS = ['sin(x^2)', 'x^2 * sin(x)', 'x^5 - 3*x^3 + 2*x', 'x^2 * y + y^3 * sin(x)'] as const;
const presetValues = near(PRESETS.map(text => valuesOf(derivative(text, 'x').result.source)));

type Ordered = { readonly text: string; readonly order: number };
const HIGHER: readonly Ordered[] = [
  { text: 'exp(x) * cos(x)', order: 5 },
  { text: '(x^2 + 1) / (x - 1)', order: 3 },
];
const higherValues = near(HIGHER.map(({ text, order }) => valuesOf(derivative(text, 'x', { order }).result.source)));

/** Raw quotient-rule results, as `derivative` returns them with `simplify: false`. */
const RAW = ['(x^2 + 1) / (x - 1)', 'x^2 * sin(x) / (x + 1)'].map(
  text => derivative(text, 'x', { simplify: false }).result.source,
);
const rawValues = near(RAW.map(text => valuesOf(text)));

const POWERS = ['(x + y + 1)^10', '(x + 1)^50'] as const;

/** The equation solver's polynomial corpus, as `lhs - (rhs)`. */
const EQUATIONS = [
  '3*x + 9',
  '2*x + 3 - (x - 4)',
  '(x + 1)/2 - (x - 1)/3',
  'x^2 - 5*x + 6',
  '2*x^2 - 7*x + 3',
  '1000000*x^2 + 1',
  'x^3 - 6*x^2 + 11*x - 6',
  'x^5 - x - 1',
] as const;

/** Two degree-30 polynomials with a known common factor of degree 10. */
const COMMON = 'x^10 + 3*x^7 - 2*x + 5';
const GCD_INPUTS = [
  [expand(`(${COMMON}) * (x^20 - x^3 + 7)`).result.source, expand(`(${COMMON}) * (x^20 + 2*x^11 - 1)`).result.source],
] as const;

type Fixture = (typeof fixtures.cases)[number];
function fixture(name: string): Fixture {
  const found = fixtures.cases.find(c => c.name === name);
  if (found === undefined) throw new Error(`no factor fixture named ${name}`);
  return found;
}
const polynomialText = (coefficients: readonly string[]): string =>
  coefficients.map((c, k) => `(${c})*x^${k}`).join(' + ');
const fixtureFactors = (c: Fixture): string[] =>
  c.factors
    .flatMap(f => Array.from({ length: f.multiplicity }, () => monic(polynomialText(f.coefficients))))
    .toSorted();

const SMALL = expand('(x - 1)^3 * (x + 2) * (2*x - 3)').result.source;
const LARGE = [fixture('random product 5'), fixture('Swinnerton-Dyer S_4')];
const LARGE_INPUTS = LARGE.map(c => polynomialText(c.input));
/** The largest fixtures have coefficients longer than the default `factorDigits` budget of 300. */
const FACTOR_LIMITS = { limits: { factorDigits: 1000, length: 100_000, tokens: 100_000 } };

/** cas's factors in the same form as `factorsOf`. */
const factorKeys = (result: ReturnType<typeof factor>): string[] =>
  result.factors.flatMap(f => Array.from({ length: f.multiplicity }, () => monic(f.factor.source))).toSorted();

export default defineSuite({
  id: '@arki/cas',
  intro:
    'Speed and size of `@arki/cas` against mathjs (pruned with `create()` to `derivative`, `simplify` and `rationalize`), Algebrite and nerdamer. Each table only ranks libraries that returned the same answer as `@arki/cas` on every input: the same values at 5 points for derivatives and simplified forms, the same coefficients for expansions, the same factors up to units for factorizations. Published numbers come only from an idle-machine run and keep every case, including the ones where `@arki/cas` is slower.',
  notes: [
    '`@arki/cas` parses, checks every budget, works exactly over ℚ with π and e as symbols, and returns a canonical expr AST with its conditions; that work is inside every timing.',
    'Algebrite is left out of three groups after an untimed probe: `factor(x^60 - 1)` took 14.7 s and left a degree-56 factor, `gcd` of the degree-30 pair took 17 s and returned 1, and it has no coefficient list in one call.',
    "mathjs has no `factor` or polynomial `gcd`, and is left out of `expand`: in an untimed probe, `rationalize('(x + 1)^10')` did not finish in 3 minutes. Its `rationalize` returns float coefficients, so it is shown, not ranked, for exact coefficients.",
  ],
  groups: [
    compare<string>({
      id: 'derivative',
      title: 'd/dx of the derivative calculator presets (`sin(x^2)`, `x^2 sin(x)`, a quintic, `x^2 y + y^3 sin(x)`)',
      contract: { id: 'cas-derivative/v1', description: 'the derivative, as values at 5 points within 1e-9 relative' },
      inputs: PRESETS,
      expected: text => presetValues(valuesOf(derivative(text, 'x').result.source)),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/cas derivative',
          package: '@arki/cas',
          run: text => derivative(text, 'x').result,
          normalize: result => presetValues(valuesOf(result.source)),
        }),
        derivation: c({
          label: '@arki/cas derivation (every step)',
          package: '@arki/cas',
          variant: true,
          run: text => derivation(text, 'x').result,
          normalize: result => presetValues(valuesOf(result.source)),
        }),
        noRecorder: c({
          label: '@arki/cas derivative, recorder deleted (RFC §9.2: the gap must stay under 3 %)',
          package: '@arki/cas',
          variant: true,
          run: text => derivativeNoRecorder(text, 'x').result,
          normalize: result => presetValues(valuesOf(result.source)),
        }),
        mathjs: c({
          label: 'mathjs derivative',
          package: 'mathjs',
          run: text => math.derivative(text, 'x'),
          normalize: node => presetValues(valuesOf(node.toString())),
        }),
        algebrite: c({
          label: 'Algebrite d',
          package: 'algebrite',
          run: text => Algebrite.run(`d(${text}, x)`),
          normalize: text => presetValues(valuesOf(text)),
        }),
        nerdamer: c({
          label: 'nerdamer diff',
          package: 'nerdamer',
          run: text => nerdamer(`diff(${text}, x)`),
          normalize: result => presetValues(valuesOf(result.toString())),
        }),
      }),
    }),
    compare<Ordered>({
      id: 'higher-order',
      title: 'Higher orders: `exp(x) cos(x)` at order 5, `(x^2 + 1)/(x - 1)` at order 3',
      contract: {
        id: 'cas-higher-order/v1',
        description: 'the n-th derivative, as values at 5 points within 1e-9 relative',
      },
      inputs: HIGHER,
      expected: ({ text, order }) => higherValues(valuesOf(derivative(text, 'x', { order }).result.source)),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/cas derivative',
          package: '@arki/cas',
          run: ({ text, order }) => derivative(text, 'x', { order }).result,
          normalize: result => higherValues(valuesOf(result.source)),
        }),
        mathjs: c({
          label: 'mathjs derivative, applied n times',
          package: 'mathjs',
          run: ({ text, order }) => {
            let node = math.parse(text);
            for (let k = 0; k < order; k++) node = math.derivative(node, 'x');
            return node;
          },
          normalize: node => higherValues(valuesOf(node.toString())),
        }),
        algebrite: c({
          label: 'Algebrite d',
          package: 'algebrite',
          run: ({ text, order }) => Algebrite.run(`d(${text}, x, ${order})`),
          normalize: text => higherValues(valuesOf(text)),
        }),
        nerdamer: c({
          label: 'nerdamer diff',
          package: 'nerdamer',
          run: ({ text, order }) => nerdamer(`diff(${text}, x, ${order})`),
          normalize: result => higherValues(valuesOf(result.toString())),
        }),
      }),
    }),
    compare<string>({
      id: 'simplify',
      title: 'Simplify a raw quotient-rule result',
      contract: { id: 'cas-simplify/v1', description: 'the same function, as values at 5 points within 1e-9 relative' },
      inputs: RAW,
      expected: text => rawValues(valuesOf(text)),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/cas simplify',
          package: '@arki/cas',
          run: text => simplify(text).result,
          normalize: result => rawValues(valuesOf(result.source)),
        }),
        mathjs: c({
          label: 'mathjs simplify',
          package: 'mathjs',
          run: text => math.simplify(text),
          normalize: node => rawValues(valuesOf(node.toString())),
        }),
        algebrite: c({
          label: 'Algebrite simplify',
          package: 'algebrite',
          run: text => Algebrite.run(`simplify(${text})`),
          normalize: text => rawValues(valuesOf(text)),
        }),
        nerdamer: c({
          label: 'nerdamer simplify',
          package: 'nerdamer',
          run: text => nerdamer(`simplify(${text})`),
          normalize: result => rawValues(valuesOf(result.toString())),
        }),
      }),
    }),
    compare<string>({
      id: 'expand',
      title: 'Expand `(x + y + 1)^10` and `(x + 1)^50`',
      contract: { id: 'cas-expand/v1', description: 'the same coefficients in x, exactly' },
      inputs: POWERS,
      expected: text => coefficientsOf(text),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/cas expand',
          package: '@arki/cas',
          run: text => expand(text).result,
          normalize: result => coefficientsOf(result.source),
        }),
        algebrite: c({
          label: 'Algebrite expand',
          package: 'algebrite',
          run: text => Algebrite.run(`expand(${text})`),
          normalize: text => coefficientsOf(text),
        }),
        nerdamer: c({
          label: 'nerdamer expand',
          package: 'nerdamer',
          run: text => nerdamer(`expand(${text})`),
          normalize: result => coefficientsOf(result.toString()),
        }),
      }),
    }),
    compare<string>({
      id: 'coefficients',
      title: 'Exact coefficients of the equation solver corpus (8 equations)',
      contract: { id: 'cas-coefficients/v1', description: 'ascending coefficients in x, as exact rationals' },
      inputs: EQUATIONS,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/cas polynomialIn',
          package: '@arki/cas',
          run: text => polynomialIn(text, 'x'),
          normalize: form =>
            form.kind === 'polynomial'
              ? form.coefficients.map(k => k.rational?.toString() ?? k.value.source)
              : [form.kind],
        }),
        mathjs: c({
          label: 'mathjs rationalize (detailed)',
          package: 'mathjs',
          differs: 'float coefficients',
          run: text => math.rationalize(text, {}, true),
          normalize: result => result.coefficients.map(String),
        }),
        nerdamer: c({
          label: 'nerdamer coeffs',
          package: 'nerdamer',
          run: text => nerdamer(`coeffs(${text}, x)`),
          normalize: result => rationalsOf(result.toString()),
        }),
      }),
    }),
    compare<readonly [string, string]>({
      id: 'gcd',
      title: 'gcd of two degree-30 polynomials with a common factor of degree 10',
      contract: { id: 'cas-gcd/v1', description: 'the gcd, up to a unit' },
      inputs: GCD_INPUTS,
      expected: () => monic(COMMON),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/cas gcd',
          package: '@arki/cas',
          run: ([a, b]) => gcd(a, b).result,
          normalize: result => monic(result.source),
        }),
        nerdamer: c({
          label: 'nerdamer gcd',
          package: 'nerdamer',
          run: ([a, b]) => nerdamer(`gcd(${a}, ${b})`),
          normalize: result => monic(result.toString()),
        }),
      }),
    }),
    compare<string>({
      id: 'factor-small',
      title: 'Factor the expanded `(x - 1)^3 (x + 2)(2x - 3)`',
      contract: { id: 'cas-factor/v1', description: 'the same irreducible factors with multiplicities, up to units' },
      inputs: [SMALL],
      expected: () => ['x - 1', 'x - 1', 'x - 1', 'x + 2', '2*x - 3'].map(f => monic(f)).toSorted(),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/cas factor',
          package: '@arki/cas',
          run: text => factor(text, 'x'),
          normalize: factorKeys,
        }),
        algebrite: c({
          label: 'Algebrite factor',
          package: 'algebrite',
          run: text => Algebrite.run(`factor(${text})`),
          normalize: text => factorsOf(text),
        }),
        nerdamer: c({
          label: 'nerdamer factor',
          package: 'nerdamer',
          run: text => nerdamer(`factor(${text})`),
          normalize: result => factorsOf(result.toString()),
        }),
      }),
    }),
    scenario({
      kind: 'scenario',
      id: 'factor-cyclotomic',
      title: 'Factor `x^60 - 1` (12 cyclotomic factors)',
      note: 'Not ranked: no other library returned the right answer. nerdamer returns 11 factors whose product has degree 44 (the degree-16 factor is missing); Algebrite took 14.7 s and left a degree-56 factor. The cas answer matches SymPy in `factor.reference.test.ts`.',
      inputs: ['x^60 - 1'],
      cases: c => ({
        arki: c({ label: '@arki/cas factor', run: text => factor(text, 'x') }),
        nerdamer: c({ label: 'nerdamer factor (wrong answer)', run: text => nerdamer(`factor(${text})`) }),
      }),
    }),
    compare<string>({
      id: 'factor-large',
      title: 'Factor a degree-40 product of 12 random irreducibles and Swinnerton-Dyer S₄ (degree 16, irreducible)',
      contract: { id: 'cas-factor/v1', description: 'the same irreducible factors with multiplicities, up to units' },
      inputs: LARGE_INPUTS,
      expected: text => {
        const found = LARGE.find((_, i) => LARGE_INPUTS[i] === text);
        return found === undefined ? [] : fixtureFactors(found);
      },
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/cas factor',
          package: '@arki/cas',
          run: text => factor(text, 'x', FACTOR_LIMITS),
          normalize: factorKeys,
        }),
        nerdamer: c({
          label: 'nerdamer factor',
          package: 'nerdamer',
          run: text => nerdamer(`factor(${text})`),
          normalize: result => factorsOf(result.toString()),
        }),
      }),
    }),
    size({
      id: 'bundle-derivative',
      title: 'Bundle: a derivative of a parsed formula',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/cas/derivative (with @arki/expr and @arki/math)',
          package: '@arki/cas',
          source: "export { derivative } from '@arki/cas/derivative';",
        },
        mathjs: {
          label: 'mathjs pruned (create + derivative, simplify, rationalize, parse)',
          package: 'mathjs',
          source: `import { create, ${MATHJS_DEPENDENCIES} } from 'mathjs'; export const math = create({ ${MATHJS_DEPENDENCIES} }, { number: 'number' });`,
        },
        algebrite: {
          label: 'Algebrite (one bundle)',
          package: 'algebrite',
          source: "export { default } from 'algebrite';",
        },
        nerdamer: {
          label: 'nerdamer core + calculus',
          package: 'nerdamer',
          source: "import nerdamer from 'nerdamer/core'; import 'nerdamer/calculus'; export default nerdamer;",
        },
      },
    }),
    size({
      id: 'bundle-factor',
      title: 'Bundle: factoring a polynomial',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/cas/polynomial factor (with @arki/expr and @arki/math)',
          package: '@arki/cas',
          source: "export { factor } from '@arki/cas/polynomial';",
        },
        algebrite: {
          label: 'Algebrite (one bundle)',
          package: 'algebrite',
          source: "export { default } from 'algebrite';",
        },
        nerdamer: {
          label: 'nerdamer core + algebra',
          package: 'nerdamer',
          source: "import nerdamer from 'nerdamer/core'; import 'nerdamer/algebra'; export default nerdamer;",
        },
      },
    }),
  ],
});
