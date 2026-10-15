// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes.
// It exercises each export once, plus a 256-deep input (RFC §16); the unit
// tests cover the details.

import { parse } from '@arki/expr';

import { CasError, CasLimitError, conditionToLatex } from '../dist/index.js';
import { collect, exactRoots, expand, gcd, polynomialIn, rationalize } from '../dist/polynomial.js';
import { simplify } from '../dist/simplify.js';

const code = run => {
  try {
    run();
    return 'none';
  } catch (error) {
    return error instanceof CasError ? error.code : error instanceof CasLimitError ? error.budget : 'other';
  }
};

const roots = text => {
  const form = polynomialIn(text, 'x');
  return form.kind === 'polynomial'
    ? exactRoots(form)
        .roots.map(r => r.value.source)
        .join(', ')
    : form.kind;
};

const simplified = (text, options) => {
  const r = simplify(text, options);
  return `${r.result.source} | ${r.conditions.map(conditionToLatex).join(', ')}`;
};

const cancelled = polynomialIn('x/x - 1', 'x');
const deep = parse(`${'('.repeat(255)}x${')'.repeat(255)}`);
const rational = rationalize('1/x + 1/(x + 1)');

const checks = [
  ['expand', expand('(x + 1)^3').result.source, 'x^3 + 3 * x^2 + 3 * x + 1'],
  ['decimal numbers', expand('0.02*x + 5', { numbers: 'decimal' }).result.source, '0.02 * x + 5'],
  ['collect', collect('2*pi*x + 3*x', 'x').result.source, '(2 * pi + 3) * x'],
  ['rationalize', `${rational.numerator.source} | ${rational.denominator.source}`, '2 * x + 1 | x^2 + x'],
  ['gcd', gcd('x^2 - 1', 'x^2 + 2x + 1').result.source, 'x + 1'],
  [
    'condition',
    cancelled.kind === 'polynomial' ? cancelled.conditions.map(conditionToLatex).join() : 'none',
    'x \\neq 0',
  ],
  ['quadratic surds', roots('x^2 - x - 1'), '(-sqrt(5) + 1) / 2, (sqrt(5) + 1) / 2'],
  ['complex roots', roots('x^2 + 4'), '-2 * i, 2 * i'],
  ['pi coefficient', roots('pi*x - 1'), '1 / pi'],
  ['transcendental', polynomialIn('sin(x) - 1', 'x').kind, 'other'],
  ['not in domain', code(() => expand('x + i')), 'not-in-domain'],
  ['degree budget', code(() => expand('(x + 1)^10000')), 'degree'],
  ['256-deep input', expand(deep).result.source, 'x'],
  ['simplify cancel', simplified('x/x'), '1 | x \\neq 0'],
  ['simplify exp-ln', simplified('exp(ln(x))'), 'x | x > 0'],
  ['simplify assumed', simplified('sqrt(x^2)', { assume: { x: 'nonnegative' } }), 'x | x \\geq 0'],
  [
    'simplify readable',
    simplified('exp(x)*cos(x) - exp(x)*sin(x) + 0*x/(x - 1)^2'),
    'exp(x) * (cos(x) - sin(x)) | x - 1 \\neq 0',
  ],
  ['simplify pi sign', simplified('abs(pi - 355/113)'), '-pi + 355 / 113 | '],
  ['simplify 256-deep input', simplify(deep).result.source, 'x'],
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
