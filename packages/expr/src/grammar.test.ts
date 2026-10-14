import { describe, expect, it } from 'vitest';

import type { Node } from './ast.js';
import type { ParseOptions } from './parser.js';
import { children, walk } from './ast.js';
import { ParseError } from './errors.js';
import { scientific } from './language.js';
import { names } from './names.js';
import { parse, parseEquation } from './parser.js';
import { print } from './print.js';

/** A fully bracketed reading of the tree, so a test sees structure, not just text. */
function sexpr(node: Node): string {
  switch (node.kind) {
    case 'number': {
      return node.raw;
    }
    case 'name': {
      return node.name;
    }
    case 'unary': {
      return `(${node.op} ${sexpr(node.arg)})`;
    }
    case 'factorial': {
      return `(! ${sexpr(node.arg)})`;
    }
    case 'group': {
      return `[${sexpr(node.inner)}]`;
    }
    case 'binary': {
      return `(${node.implicit ? '·' : node.op} ${sexpr(node.left)} ${sexpr(node.right)})`;
    }
    case 'call': {
      return `(${node.fn}${node.notation === 'call' ? '' : `:${node.notation}`} ${node.args.map(arg => sexpr(arg)).join(' ')})`;
    }
  }
}

function read(text: string, options?: ParseOptions): { tree: string; canonical: string } {
  const expr = parse(text, options);
  return { tree: sexpr(expr.root), canonical: print(expr) };
}

function parseError(text: string, options?: ParseOptions): ParseError {
  try {
    parse(text, options);
  } catch (error) {
    if (error instanceof ParseError) return error;
    throw error;
  }
  throw new Error(`expected "${text}" to be rejected`);
}

describe('§4.2 precedence, one test per row', () => {
  it('1: literals, names, calls, groups, bars and radicals are atoms', () => {
    expect(read('sin(x)')).toEqual({ tree: '(sin x)', canonical: 'sin(x)' });
    expect(read('|x-1|')).toEqual({ tree: '(abs:bars (- x 1))', canonical: '|x - 1|' });
    expect(read('√x')).toEqual({ tree: '(sqrt:radical x)', canonical: 'sqrt(x)' });
  });

  it('2: postfix ! binds tighter than ^, so 3!^2 is (3!)^2 = 36, not 3^2 factorial', () => {
    expect(read('3!^2')).toEqual({ tree: '(^ (! 3) 2)', canonical: '3!^2' });
  });

  it('3: ^ is right-associative with a unary exponent: 2^3^2 = 512, 2^-1 = 0.5, 2^3! = 64', () => {
    expect(read('2^3^2')).toEqual({ tree: '(^ 2 (^ 3 2))', canonical: '2^3^2' });
    expect(read('2^-1')).toEqual({ tree: '(^ 2 (- 1))', canonical: '2^-1' });
    expect(read('2^3!')).toEqual({ tree: '(^ 2 (! 3))', canonical: '2^3!' });
  });

  it('4: unary minus is below ^ and !, so -2^2 = -4 and -x! = -(x!)', () => {
    expect(read('-2^2')).toEqual({ tree: '(- (^ 2 2))', canonical: '-2^2' });
    expect(read('-x!')).toEqual({ tree: '(- (! x))', canonical: '-x!' });
  });

  it('5: implicit multiplication shares * and / precedence, left to right: 1/2x = x/2, 2x^2 = 2·x²', () => {
    expect(read('1/2x')).toEqual({ tree: '(· (/ 1 2) x)', canonical: '1 / 2 * x' });
    expect(read('2x^2')).toEqual({ tree: '(· 2 (^ x 2))', canonical: '2 * x^2' });
  });

  it('6: binary - is subtraction, so 2-3 = -1 is never 2·(-3)', () => {
    expect(read('2-3')).toEqual({ tree: '(- 2 3)', canonical: '2 - 3' });
    expect(read('2 -3')).toEqual({ tree: '(- 2 3)', canonical: '2 - 3' });
  });

  it('7: = appears only in equations, at the lowest level', () => {
    const equation = parseEquation('x^2 + 1 = 2x');
    expect([sexpr(equation.left), sexpr(equation.right)]).toEqual(['(+ (^ x 2) 1)', '(· 2 x)']);
    expect(print(equation)).toBe('x^2 + 1 = 2 * x');
    expect(parseError('x = 1').code).toBe('unexpected-token');
  });
});

describe('§4.3 juxtaposition table, one test per cell', () => {
  const variables = { variables: ['x', 'y', 'a'] };

  it('number then name, (, | multiply; number then number is an error', () => {
    expect(read('2x').tree).toBe('(· 2 x)');
    expect(read('2pi').tree).toBe('(· 2 pi)');
    expect(read('2(x+1)').tree).toBe('(· 2 [(+ x 1)])');
    expect(read('2|x|').tree).toBe('(· 2 (abs:bars x))');
    expect(parseError('2 3')).toMatchObject({ code: 'unexpected-token', span: { start: 2, end: 3 } });
  });

  it('closing ) or | then name, (, | multiply; then a number is an error (almost always a typo)', () => {
    expect(read('(x+1)x').tree).toBe('(· [(+ x 1)] x)');
    expect(read('(x+1)(x-1)').tree).toBe('(· [(+ x 1)] [(- x 1)])');
    expect(read('(x)|y|').tree).toBe('(· [x] (abs:bars y))');
    expect(read('|x|y').tree).toBe('(· (abs:bars x) y)');
    expect(read('|x|(y)').tree).toBe('(· (abs:bars x) [y])');
    expect(read('|x||y|').tree).toBe('(· (abs:bars x) (abs:bars y))');
    expect(parseError('(a)2')).toMatchObject({ code: 'unexpected-token', found: '2' });
    expect(parseError('|a|2')).toMatchObject({ code: 'unexpected-token', found: '2' });
  });

  it('a variable or constant then name, (, | multiplies; then a number is an error', () => {
    expect(read('x y').tree).toBe('(· x y)');
    expect(read('x(y+1)', variables).tree).toBe('(· x [(+ y 1)])');
    expect(read('pi(x)').tree).toBe('(· pi [x])');
    expect(read('x|y|').tree).toBe('(· x (abs:bars y))');
    expect(parseError('x 2')).toMatchObject({ code: 'unexpected-token', found: '2' });
  });

  it('x2 is one name, never x·2', () => {
    expect(read('x2').tree).toBe('x2');
  });

  it('f(x) is a call only for registered functions; an unknown name before ( is never guessed', () => {
    expect(read('sin(x)').tree).toBe('(sin x)');
    expect(parseError('foo(x)')).toMatchObject({ code: 'not-a-function', span: { start: 0, end: 3 }, found: 'foo' });
    // Without the declared variables the parser cannot tell x(…) from a typo for a function.
    expect(parseError('x(y+1)').code).toBe('not-a-function');
  });

  it('multi-letter names stay as typed; a split of declared letters still reads as a product before (', () => {
    expect(read('xy').tree).toBe('xy');
    expect(read('xy').canonical).toBe('xy');
    expect(read('xy(a)', variables).tree).toBe('(· xy [a])');
    expect(parseError('xpi(a)', variables).code).toBe('not-a-function');
    expect(parseError('xsin(y)', variables).code).toBe('not-a-function');
  });

  it('2e+1 is the literal 20; 2e alone is 2·e, and canonical text keeps the two apart', () => {
    expect(parse('2e+1').root).toMatchObject({ kind: 'number', raw: '2e+1' });
    expect(read('2e').tree).toBe('(· 2 e)');
    expect(read('2e + 1')).toEqual({ tree: '(+ (· 2 e) 1)', canonical: '2 * e + 1' });
    // The stored text reads back as a product, never as the literal 2e+1 = 20.
    expect(sexpr(parse(print(parse('2e + 1'))).root)).toBe('(+ (* 2 e) 1)');
  });

  it('functions need parentheses: sin x and sin^2(x) are errors with a hint', () => {
    expect(parseError('sin x')).toMatchObject({ code: 'unexpected-token', expected: ['('], found: 'x' });
    expect(parseError('sin x').message).toContain('sin(x)');
    expect(parseError('sin^2(x)').message).toContain('sin(x)^2');
    expect(parseError('sin')).toMatchObject({ code: 'unexpected-end', expected: ['('] });
  });

  it('a bar opens where an operand is expected and closes otherwise', () => {
    expect(read('||x|-|y||').tree).toBe('(abs:bars (- (abs:bars x) (abs:bars y)))');
    expect(read('|-x|').tree).toBe('(abs:bars (- x))');
    expect(read('|x-|y||').tree).toBe('(abs:bars (- x (abs:bars y)))');
    expect(parseError('|x|y|')).toMatchObject({ code: 'unbalanced-bar', span: { start: 4, end: 5 } });
    expect(parseError('|x')).toMatchObject({ code: 'unbalanced-bar', span: { start: 0, end: 1 } });
  });

  it('2^3x is (2^3)·x = 8x and 1/2x is (1/2)·x, each with a warning that shows the reading', () => {
    const power = parse('2^3x');
    expect(sexpr(power.root)).toBe('(· (^ 2 3) x)');
    expect(power.warnings).toEqual([
      expect.objectContaining({
        code: 'implicit-after-power',
        span: { start: 0, end: 4 },
        hint: 'write (2^3)x or 2^(3x)',
      }),
    ]);
    const division = parse('1/2x');
    expect(division.warnings).toEqual([
      expect.objectContaining({
        code: 'implicit-after-division',
        span: { start: 0, end: 4 },
        hint: 'write (1/2)x or 1/(2x)',
      }),
    ]);
    expect(parse('a/b c', variables).warnings).toHaveLength(1);
    expect(parse('2x^2').warnings).toEqual([]);
    expect(parse('(1/2)x').warnings).toEqual([]);
  });
});

describe('acceptance (RFC §3, parse side)', () => {
  it('C-01: number literals, including what toString() feeds back from the keypad', () => {
    for (const raw of ['0', '42', '3.14', '.5', '1e-7', '2E+3', '0.30000000000000004', '1e+21', '0.50']) {
      expect(parse(raw).root).toEqual({ kind: 'number', raw, span: { start: 0, end: raw.length } });
    }
    expect(parseError('2.').code).toBe('bad-number');
    expect(parseError('1.2.3')).toMatchObject({ code: 'bad-number', span: { start: 0, end: 5 } });
  });

  it('C-02: + - * / with the usual precedence', () => {
    expect(read('1 + 2 * 3 - 4 / 5').tree).toBe('(- (+ 1 (* 2 3)) (/ 4 5))');
  });

  it('C-03: ^ is right-associative and (a)^(1/n) keeps its groups', () => {
    expect(read('(a)^(1/n)').tree).toBe('(^ [a] [(/ 1 n)])');
  });

  it('C-04: unary minus and plus', () => {
    expect(read('-2^2').tree).toBe('(- (^ 2 2))');
    expect(read('+x - -y').tree).toBe('(- (+ x) (- y))');
  });

  it('C-05: parentheses stay as group nodes with their content', () => {
    const root = parse('(x+1)').root;
    expect(root.kind).toBe('group');
    expect(root.kind === 'group' && root.inner.kind).toBe('binary');
  });

  it('C-06: implicit multiplication forms are flagged implicit', () => {
    for (const text of ['2x', '2(x+1)', '(x+1)(x-1)', '3sin(x)', '2pi']) {
      expect(parse(text).root).toMatchObject({ kind: 'binary', op: '*', implicit: true });
    }
    expect(parse('2*x').root).toMatchObject({ implicit: false });
  });

  it('C-07: calls with 1..n arguments, checked against the arity', () => {
    expect(read('log(x, b)').tree).toBe('(log x b)');
    expect(read('nthRoot(x, 3)').tree).toBe('(nthRoot x 3)');
    expect(read('pow(x, y)').tree).toBe('(pow x y)');
    expect(parseError('pow(1)')).toMatchObject({ code: 'arity', span: { start: 0, end: 6 } });
    expect(parseError('sin(1, 2)').code).toBe('arity');
    expect(parseError('log(1, 2, 3)').code).toBe('arity');
  });

  it('C-08: every scientific function parses at its minimum arity', () => {
    const expected = [
      'sin cos tan sec csc cot asin acos atan asec acsc acot',
      'sinh cosh tanh sech csch coth asinh acosh atanh asech acsch acoth',
      'exp ln log log10 log2 sqrt cbrt nthRoot pow abs sign ceil floor round fix factorial gamma mod',
    ]
      .join(' ')
      .split(' ');
    expect(scientific.functionNames()).toEqual(expected.toSorted());
    for (const fn of expected) {
      const [min] = scientific.functionSpec(fn)?.arity ?? [1];
      const args = Array.from({ length: min }, () => 'x').join(', ');
      expect(parse(`${fn}(${args})`).root).toMatchObject({ kind: 'call', fn });
    }
  });

  it('C-09: pi, e and i are constants of the scientific language', () => {
    expect(names(parse('pi + e + i + x'))).toEqual({ variables: ['x'], constants: ['e', 'i', 'pi'], functions: [] });
  });

  it('C-10: display operators × · ÷ − read as their ASCII forms', () => {
    expect(read('2 × 3 · 4 ÷ 5 − 1').tree).toBe(read('2 * 3 * 4 / 5 - 1').tree);
    expect(read('π').tree).toBe('pi');
    expect(read('√2').tree).toBe('(sqrt:radical 2)');
  });

  it('C-11: |expr| is absolute value and nests', () => {
    expect(read('|x - |y||').canonical).toBe('|x - |y||');
  });

  it('C-13: named variables, including Greek', () => {
    expect(names(parse('x + t + theta + θ')).variables).toEqual(['t', 'theta', 'x', 'θ']);
  });

  it('C-14: equations split on exactly one =', () => {
    const equation = parseEquation('x^2 = 2x + 1');
    expect(print(equation)).toBe('x^2 = 2 * x + 1');
    expect(() => parseEquation('a = b = c')).toThrow(ParseError);
    expect(() => parseEquation('x + 1')).toThrow(expect.objectContaining({ code: 'unexpected-end', expected: ['='] }));
    expect(() => parseEquation('(a = b)')).toThrow(expect.objectContaining({ code: 'unexpected-token' }));
  });

  it('C-19: parse-only validation gives a readable, located error', () => {
    const error = parseError('2 + * 3');
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ code: 'unexpected-token', span: { start: 4, end: 5 }, position: 4, found: '*' });
    expect(error.expected).toContain('number');
    expect(error.name).toBe('ParseError');
  });

  it('C-20: parse-side error categories are codes, not message text', () => {
    expect(parseError('foo(2)').code).toBe('not-a-function');
    expect(parseError('2 +').code).toBe('unexpected-end');
    expect(parseError('(2').code).toBe('unbalanced-paren');
    expect(parseError('2)').code).toBe('unbalanced-paren');
    expect(parseError('2 $ 3').code).toBe('unexpected-token');
  });

  it('C-23: free-variable analysis without a hand-kept function list', () => {
    expect(names(parse('2x^2 + sin(x) + pi*y + |z| + √w'))).toEqual({
      variables: ['w', 'x', 'y', 'z'],
      constants: ['pi'],
      functions: ['abs', 'sin', 'sqrt'],
    });
    expect(names(parseEquation('a = b + 1')).variables).toEqual(['a', 'b']);
  });

  it('C-24: nodes expose kind, operator, arguments, function name and group content', () => {
    const root = parse('(a + 1) * log(b, 2)').root;
    expect(children(root).map(child => child.kind)).toEqual(['group', 'call']);
    const visited: string[] = [];
    walk(root, node => {
      visited.push(node.kind);
      return node.kind !== 'call';
    });
    expect(visited).toEqual(['binary', 'group', 'binary', 'name', 'number', 'call']);
  });

  it('C-25: canonical text parses back to the same tree', () => {
    for (const text of ['2 * x^2 + sin(x)', '-(a + b)^2 / 3!', 'log(|x - 1|, 2)', '2^-3^2']) {
      expect(sexpr(parse(print(parse(text))).root)).toBe(sexpr(parse(text).root));
      expect(print(parse(text))).toBe(text);
    }
  });
});

describe('spans', () => {
  it('are UTF-16 offsets covering what the user typed', () => {
    const root = parse(' √(x) + |y| ').root;
    expect(root.span).toEqual({ start: 1, end: 11 });
    expect(root.kind === 'binary' && [root.left.span, root.right.span]).toEqual([
      { start: 1, end: 5 },
      { start: 8, end: 11 },
    ]);
  });
});
