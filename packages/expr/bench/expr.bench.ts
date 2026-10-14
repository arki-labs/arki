// Speed and size of @arki/expr against mathjs (pruned with create() to the
// functions these formulas use, numbers only) and expr-eval.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme` on an idle machine.
//
// Every `compare` group is checked before timing: each ranked library must
// return the same value as @arki/expr on every input, within 4 ulps (RFC §14).
// No parse cache keyed by text and no input-shaped fast paths: every run of
// `parse` and `evaluate` does the whole work again.

import type { Expression } from 'expr-eval';
import { Parser } from 'expr-eval';
import {
  absDependencies,
  addDependencies,
  compileDependencies,
  cosDependencies,
  create,
  divideDependencies,
  evaluateDependencies,
  expDependencies,
  multiplyDependencies,
  parseDependencies,
  powDependencies,
  sinDependencies,
  sqrtDependencies,
  subtractDependencies,
  unaryMinusDependencies,
} from 'mathjs';

import { compare, defineSuite, size } from '@arki/bench';
import { parse } from '@arki/expr';
import { compile, evaluate } from '@arki/expr/float';

const math = create(
  {
    absDependencies,
    addDependencies,
    compileDependencies,
    cosDependencies,
    divideDependencies,
    evaluateDependencies,
    expDependencies,
    multiplyDependencies,
    parseDependencies,
    powDependencies,
    sinDependencies,
    sqrtDependencies,
    subtractDependencies,
    unaryMinusDependencies,
  },
  { number: 'number' },
);
const exprEval = new Parser();
/** The same pruned set as `math` above, as source for the bundle-size case. */
const MATHJS_DEPENDENCIES = [
  'abs',
  'add',
  'compile',
  'cos',
  'divide',
  'evaluate',
  'exp',
  'multiply',
  'parse',
  'pow',
  'sin',
  'sqrt',
  'subtract',
  'unaryMinus',
]
  .map(name => `${name}Dependencies`)
  .join(', ');

const MAGNITUDE = (1n << 63n) - 1n;

/** Maps a double's bit pattern (sign and magnitude) to an integer that orders like the double. */
function ordered(bits = 0n): bigint {
  return bits < 0n ? -(bits & MAGNITUDE) : bits;
}

/** Distance in units in the last place; non-finite values are only equal to themselves. */
function ulps(a: number, b: number): number {
  if (Object.is(a, b) || a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  const bits = new BigInt64Array(new Float64Array([a, b]).buffer);
  const distance = ordered(bits[0]) - ordered(bits[1]);
  return Number(distance < 0n ? -distance : distance);
}

/**
 * The 4-ulp contract as a normalization: a value within 4 ulps of the
 * reference for the same input becomes that reference, anything else stays
 * as it is and fails the harness's equality check.
 */
const within4Ulps =
  (references: readonly number[]) =>
  (value: number): number =>
    references.find(reference => ulps(reference, value) <= 4) ?? value;

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

const KEYPAD = '12.5*4-3^2/1.25';
const GRAPH = 'sin(x)*x^2 + 3*x - 1 + cos(2*x)/(1 + x^2) - sqrt(abs(x) + 1)*exp(-x/4) + x^3/6';
const TERMS = ['sin(x*1.5)*x^2', '3*x/(x^2+1)', 'sqrt(abs(x)+2)', 'cos(x/3)*exp(-x/5)', '(x-1)^3/7', 'abs(x-2)*0.25'];
const GENERATED = (() => {
  let text = TERMS[0] ?? '';
  for (let index = 1; text.length < 2000; index++) {
    text += `${index % 2 === 0 ? ' + ' : ' - '}${TERMS[index % TERMS.length] ?? ''}`;
  }
  return text;
})();
const AT = 0.5;
const parseInputs = [KEYPAD, GRAPH, GENERATED] as const;
const atHalf = (text: string): number => compile(parse(text), { variables: ['x'] }).at(AT);
const parseNormal = within4Ulps(parseInputs.map(text => atHalf(text)));

const POINTS = 10_000;
const CURVE = 'sin(x)*x^2 + 3*x - 1';
const XS = Float64Array.from({ length: POINTS }, (_, index) => -10 + (20 * index) / POINTS);
const curve = compile(parse(CURVE), { variables: ['x'] });
const curveReference = [...XS].map(x => curve.at(x));
const curveNormal = (values: ArrayLike<number>): number[] =>
  Array.from(values, (value, index) => within4Ulps([curveReference[index] ?? Number.NaN])(value));

const KEYPAD_INPUTS = ['2^10 - 1', KEYPAD, '(1 + 2)*3/4 - 0.5^3'] as const;
const keypadNormal = within4Ulps(KEYPAD_INPUTS.map(text => evaluate(text)));

export default defineSuite({
  id: '@arki/expr',
  intro:
    'Speed and size of `@arki/expr` against mathjs (pruned with `create()` to the functions these formulas use, with `{ number: "number" }`) and expr-eval. Each table only ranks libraries that returned the same value as `@arki/expr` on every input, within 4 ulps. Published numbers come only from an idle-machine run and keep every case, including the ones where `@arki/expr` is slower.',
  notes: [
    '`@arki/expr` resolves names, checks the language and the budgets at parse and compile time; `f()` and `f.at()` check every operation and throw typed errors instead of returning NaN or Infinity. `f.sample()` is the unchecked IEEE path, where NaN marks a gap.',
    'mathjs `compile().evaluate()` takes a scope object per point. expr-eval is timed through `Expression.evaluate`; its `toJSFunction` builds code with `new Function`, which `@arki/expr` never does, so it is timed as compile only.',
    'Parse results are compared by evaluating each parsed tree at x = 0.5 (untimed).',
  ],
  groups: [
    compare<string>({
      id: 'parse',
      title: 'Parse (15-char keypad input, 80-char graph formula, generated 2 KB formula)',
      contract: { id: 'expr-parse/v1', description: 'the parsed formula, evaluated at x = 0.5, within 4 ulps' },
      inputs: parseInputs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/expr parse',
          package: '@arki/expr',
          run: text => parse(text),
          normalize: expr => parseNormal(compile(expr, { variables: ['x'] }).at(AT)),
        }),
        mathjs: c({
          label: 'mathjs parse',
          package: 'mathjs',
          run: text => math.parse(text),
          normalize: node => parseNormal(numberOf(node.compile().evaluate({ x: AT }))),
        }),
        exprEval: c({
          label: 'expr-eval parse',
          package: 'expr-eval',
          run: (text): Expression => exprEval.parse(text),
          normalize: expression => {
            const value: unknown = expression.evaluate({ x: AT });
            return parseNormal(numberOf(value));
          },
        }),
      }),
    }),
    compare<string>({
      id: 'compile',
      title: 'Compile the 80-char formula',
      contract: { id: 'expr-compile/v1', description: 'the compiled formula at x = 0.5, within 4 ulps' },
      inputs: [GRAPH],
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/expr compile',
          package: '@arki/expr',
          setup: text => parse(text),
          run: expr => compile(expr, { variables: ['x'] }),
          normalize: f => parseNormal(f.at(AT)),
        }),
        mathjs: c({
          label: 'mathjs compile',
          package: 'mathjs',
          setup: text => math.parse(text),
          run: node => node.compile(),
          normalize: compiled => parseNormal(numberOf(compiled.evaluate({ x: AT }))),
        }),
        exprEval: c({
          label: 'expr-eval toJSFunction',
          package: 'expr-eval',
          setup: (text): Expression => exprEval.parse(text),
          run: expression => expression.toJSFunction('x'),
          normalize: f => parseNormal(f(AT)),
        }),
      }),
    }),
    compare<string>({
      id: 'evaluate-10k',
      title: `Evaluate ${CURVE} at 10 000 points`,
      contract: { id: 'expr-evaluate-10k/v1', description: 'the 10 000 values, each within 4 ulps' },
      inputs: [CURVE],
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/expr f.at loop',
          package: '@arki/expr',
          setup: text => ({ f: compile(parse(text), { variables: ['x'] }), out: new Float64Array(POINTS) }),
          run: ({ f, out }) => {
            for (let index = 0; index < POINTS; index++) out[index] = f.at(XS[index] ?? 0);
            return out;
          },
          normalize: curveNormal,
        }),
        sample: c({
          label: '@arki/expr f.sample',
          package: '@arki/expr',
          variant: true,
          setup: text => ({ f: compile(parse(text), { variables: ['x'] }), out: new Float64Array(POINTS) }),
          run: ({ f, out }) => f.sample(XS, out),
          normalize: curveNormal,
        }),
        mathjs: c({
          label: 'mathjs compile().evaluate loop',
          package: 'mathjs',
          setup: text => ({ f: math.compile(text), out: new Float64Array(POINTS) }),
          run: ({ f, out }) => {
            for (let index = 0; index < POINTS; index++) out[index] = numberOf(f.evaluate({ x: XS[index] ?? 0 }));
            return out;
          },
          normalize: curveNormal,
        }),
        exprEval: c({
          label: 'expr-eval Expression.evaluate loop',
          package: 'expr-eval',
          setup: text => ({ expression: exprEval.parse(text), out: new Float64Array(POINTS) }),
          run: ({ expression, out }) => {
            for (let index = 0; index < POINTS; index++) {
              const value: unknown = expression.evaluate({ x: XS[index] ?? 0 });
              out[index] = numberOf(value);
            }
            return out;
          },
          normalize: curveNormal,
        }),
      }),
    }),
    compare<string>({
      id: 'one-shot',
      title: 'One-shot keypad evaluation (parse + evaluate)',
      contract: { id: 'expr-one-shot/v1', description: 'the value of the keypad input, within 4 ulps' },
      inputs: KEYPAD_INPUTS,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/expr evaluate',
          package: '@arki/expr',
          run: text => evaluate(text),
          normalize: keypadNormal,
        }),
        mathjs: c({
          label: 'mathjs evaluate',
          package: 'mathjs',
          run: (text): unknown => math.evaluate(text),
          normalize: value => keypadNormal(numberOf(value)),
        }),
        exprEval: c({
          label: 'expr-eval Parser.evaluate',
          package: 'expr-eval',
          run: text => exprEval.evaluate(text),
          normalize: keypadNormal,
        }),
      }),
    }),
    size({
      id: 'bundle',
      title: 'Bundle: parse + compile to a float function',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/expr + @arki/expr/float',
          package: '@arki/expr',
          limit: '15 kB',
          source: "export { parse } from '@arki/expr'; export { compile } from '@arki/expr/float';",
        },
        mathjs: {
          label: 'mathjs pruned (create + the same functions, numbers only)',
          package: 'mathjs',
          source: `import { create, ${MATHJS_DEPENDENCIES} } from 'mathjs'; export const math = create({ ${MATHJS_DEPENDENCIES} }, { number: 'number' });`,
        },
        exprEval: {
          label: 'expr-eval (Parser)',
          package: 'expr-eval',
          source: "export { Parser } from 'expr-eval';",
        },
      },
    }),
  ],
});
