// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes.
// It exercises each export once, plus a 256-deep expression (RFC §18); the
// unit tests cover the details.

import { compile, evaluate } from '../dist/float.js';
import {
  decimalComma,
  defineLanguage,
  ExprLimitError,
  fromJSON,
  names,
  parse,
  parseEquation,
  ParseError,
  print,
  scientific,
} from '../dist/index.js';
import { toLatex } from '../dist/latex.js';

const code = run => {
  try {
    run();
    return 'none';
  } catch (error) {
    return error instanceof ParseError ? error.code : error instanceof ExprLimitError ? error.budget : 'other';
  }
};

const deep = `${'('.repeat(255)}x${')'.repeat(255)}`;
const message = run => {
  try {
    run();
    return 'none';
  } catch (error) {
    return error instanceof Error ? error.message : 'other';
  }
};
const gaps = compile(parse('1/x'), { variables: ['x'] }).sample(new Float64Array([0, 2]), new Float64Array(2));

const physics = defineLanguage({ extends: scientific, functions: { hypot: { arity: [2, 16] } } });

const checks = [
  ['canonical print', print(parse('2x^2 + sin(x)')), '2 * x^2 + sin(x)'],
  ['display print', print(parse('2x^2 − √x'), { style: 'display' }), '2x^2 − √x'],
  ['decimal comma', print(parse('log(0,50; 2)', { syntax: decimalComma })), 'log(0.50, 2)'],
  ['equation', print(parseEquation('x^2 = 2x')), 'x^2 = 2 * x'],
  ['names', names(parse('pi*x + |y|')).variables.join(), 'x,y'],
  ['host language', print(parse('hypot(3, 4)', { language: physics })), 'hypot(3, 4)'],
  ['fromJSON', print(fromJSON(JSON.parse(JSON.stringify(parse('1/2x'))))), '1 / 2 * x'],
  ['not a function', code(() => parse('foo(x)')), 'not-a-function'],
  ['unbalanced bar', code(() => parse('|x|y|')), 'unbalanced-bar'],
  ['256-deep expression', print(parse(deep)), deep],
  ['float evaluate', evaluate('2^10 - 1'), 1023],
  ['float degrees', evaluate('sin(90)', { angle: 'deg' }), 1],
  ['float 256-deep expression', compile(parse(deep), { variables: ['x'] }).at(3), 3],
  ['float typed error', message(() => evaluate('1/0')), 'Division by zero: 1 / 0'],
  ['float sample gap', `${gaps[0]},${gaps[1]}`, 'NaN,0.5'],
  ['latex', toLatex(parse('sqrt(x)/2')), '\\frac{\\sqrt{x}}{2}'],
  [
    '100 000 parentheses',
    code(() => parse(`${'('.repeat(100000)}x`, { limits: { length: 200000, tokens: 200000 } })),
    'depth',
  ],
];

const runtime =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
