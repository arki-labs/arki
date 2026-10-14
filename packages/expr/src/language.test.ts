import { afterEach, describe, expect, it } from 'vitest';

import { InvalidArgumentError, MathError, UnsupportedFeatureError } from '@arki/math/errors';

import { ParseError } from './errors.js';
import { defineLanguage, scientific } from './language.js';
import { names } from './names.js';
import { parse } from './parser.js';
import { print } from './print.js';
import { canonical, decimalComma, defineSyntax, syntaxFor } from './syntax.js';

describe('defineLanguage', () => {
  const physics = defineLanguage({
    extends: scientific,
    functions: { hypot: { arity: [2, 16], latex: '\\operatorname{hypot}' } },
    constants: { g: { latex: 'g' } },
  });

  it('extends a language with host functions and constants', () => {
    expect(physics.functionSpec('hypot')).toEqual({ arity: [2, 16], latex: '\\operatorname{hypot}', cost: 1 });
    expect(physics.functionSpec('sin')).toEqual(scientific.functionSpec('sin'));
    const expr = parse('hypot(x, g) + sin(x)', { language: physics });
    // names() classifies against the language it is given, like parse.
    expect(names(expr).variables).toEqual(['g', 'x']);
    expect(names(expr, { language: physics })).toEqual({
      variables: ['x'],
      constants: ['g'],
      functions: ['hypot', 'sin'],
    });
  });

  it('is a whitelist: only what the language registers is callable', () => {
    expect(() => parse('hypot(3, 4)')).toThrow(expect.objectContaining({ code: 'not-a-function' }));
    const bare = defineLanguage({ functions: { f: { arity: 1 } } });
    expect(() => parse('sin(x)', { language: bare })).toThrow(ParseError);
    // `|x|` and `√x` are notations for abs and sqrt, so they need them too.
    expect(() => parse('|x|', { language: bare })).toThrow(expect.objectContaining({ code: 'not-a-function' }));
    expect(() => parse('√x', { language: bare })).toThrow(expect.objectContaining({ code: 'not-a-function' }));
    expect(print(parse('f(x)', { language: bare }))).toBe('f(x)');
  });

  it('rejects invalid names, arities and every collision', () => {
    expect(() => defineLanguage({ functions: { '2f': { arity: 1 } } })).toThrow(InvalidArgumentError);
    expect(() => defineLanguage({ functions: { 'a.b': { arity: 1 } } })).toThrow(InvalidArgumentError);
    expect(() => defineLanguage({ constants: { π: {} } })).toThrow(InvalidArgumentError);
    expect(() => defineLanguage({ functions: { f: { arity: -1 } } })).toThrow(InvalidArgumentError);
    expect(() => defineLanguage({ functions: { f: { arity: [3, 2] } } })).toThrow(InvalidArgumentError);
    expect(() => defineLanguage({ functions: { f: { arity: 1.5 } } })).toThrow(InvalidArgumentError);
    expect(() => defineLanguage({ functions: { f: { arity: 1 } }, constants: { f: {} } })).toThrow(/conflict/);
    expect(() => defineLanguage({ extends: scientific, functions: { sin: { arity: 1 } } })).toThrow(/conflict/);
    expect(() => defineLanguage({ extends: scientific, constants: { pi: {} } })).toThrow(/conflict/);
  });

  it('takes a step cost per host function, a positive integer, so the steps budget can count slow functions', () => {
    const lang = defineLanguage({ functions: { slow: { arity: 1, cost: 40 } } });
    expect(lang.functionSpec('slow')?.cost).toBe(40);
    for (const cost of [0, -1, 1.5, Number.NaN]) {
      expect(() => defineLanguage({ functions: { slow: { arity: 1, cost } } })).toThrow(InvalidArgumentError);
    }
  });

  it('cannot be changed after it is built', () => {
    expect(Object.isFrozen(scientific)).toBe(true);
    expect(Object.isFrozen(scientific.functionSpec('log'))).toBe(true);
    const listed: string[] = scientific.functionNames();
    listed.push('eval');
    expect(scientific.functionNames()).not.toContain('eval');
    expect(scientific.functionSpec('eval')).toBeUndefined();
  });

  it('treats prototype names as ordinary names that are not there', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(scientific.functionSpec(name)).toBeUndefined();
      expect(scientific.constantSpec(name)).toBeUndefined();
    }
    const odd = defineLanguage({ functions: { ['__proto__']: { arity: 1 }, constructor: { arity: 1 } } });
    expect(odd.functionNames()).toEqual(['__proto__', 'constructor']);
    expect(parse('constructor(__proto__(1))', { language: odd }).root).toMatchObject({
      kind: 'call',
      fn: 'constructor',
    });
  });

  it('rejects a language object it did not build', () => {
    const fake = { ...scientific };
    expect(() => parse('x', { language: fake })).toThrow(InvalidArgumentError);
  });
});

describe('syntax', () => {
  const original = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'formatToParts');
  afterEach(() => {
    if (original !== undefined) Object.defineProperty(Intl.NumberFormat.prototype, 'formatToParts', original);
  });

  it('rejects a decimal comma with a comma separator: 1,5 could not also split arguments', () => {
    expect(() => defineSyntax({ decimal: ',', separator: ',' })).toThrow(InvalidArgumentError);
    expect(defineSyntax({ decimal: ',', separator: ';' })).toEqual(decimalComma);
    expect(defineSyntax({ decimal: '.', separator: ';' })).toEqual({ decimal: '.', separator: ';' });
  });

  it('never accepts group separators inside expressions', () => {
    expect(() => parse('1,234')).toThrow(expect.objectContaining({ code: 'unexpected-token' }));
    expect(() => parse('1.234,5', { syntax: decimalComma })).toThrow(ParseError);
  });

  it('decimal comma: f(1,5; 2) is unambiguous and stores as f(1.5, 2)', () => {
    expect(print(parse('log(1,5; 2)', { syntax: decimalComma }))).toBe('log(1.5, 2)');
    expect(() => parse('log(1, 5)', { syntax: decimalComma })).toThrow(expect.objectContaining({ code: 'bad-number' }));
    expect(() => parse('log(x,y)', { syntax: decimalComma })).toThrow(/separates arguments with ";"/);
  });

  it('syntaxFor maps a locale to a preset, calling Intl only when called', () => {
    expect(syntaxFor('de-DE')).toBe(decimalComma);
    expect(syntaxFor('ro-RO')).toBe(decimalComma);
    expect(syntaxFor('en-US')).toBe(canonical);
    expect(syntaxFor(['fr-FR'])).toBe(decimalComma);
  });

  it('syntaxFor throws UnsupportedFeatureError without formatToParts (Hermes on iOS)', () => {
    Object.defineProperty(Intl.NumberFormat.prototype, 'formatToParts', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(() => syntaxFor('de-DE')).toThrow(UnsupportedFeatureError);
    expect(() => syntaxFor('de-DE')).toThrow(MathError);
  });
});
