import { describe, expect, it } from 'vitest';

import {
  camelCase,
  capitalize,
  caseWords,
  constantCase,
  dotCase,
  kebabCase,
  pascalCase,
  pathCase,
  sentenceCase,
  snakeCase,
  titleCase,
  uncapitalize,
} from './case.js';

describe('caseWords', () => {
  it.each<[string, string[]]>([
    ['XMLHttpRequest', ['XML', 'Http', 'Request']],
    ['getURLValue', ['get', 'URL', 'Value']],
    ['HTTP2Server', ['HTTP2', 'Server']],
    ['v2Beta', ['v2', 'Beta']],
    ['iPhone11Pro', ['i', 'Phone11', 'Pro']],
    ['sha256sum', ['sha256sum']],
    ['99Bottles', ['99', 'Bottles']],
    ['crème brûlée', ['crème', 'brûlée']],
    ['crème', ['crème']],
    ['déjà_Vu', ['déjà', 'Vu']],
    ['foo__bar.baz/qux', ['foo', 'bar', 'baz', 'qux']],
    ["don't-stop", ['dont', 'stop']],
    ['hello👩‍💻World', ['hello', 'World']],
    ['你好世界', ['你好世界']],
    ['İstanbul', ['İstanbul']],
    ['___', []],
    ['', []],
    ['  ', []],
    ['ID', ['ID']],
    ['ÉcoleNormale', ['École', 'Normale']],
  ])('%j → %j', (input, tokens) => {
    expect(caseWords(input)).toEqual(tokens);
  });
});

describe('case styles', () => {
  const input = 'XMLHttpRequest v2Beta';
  it('converts', () => {
    expect(camelCase(input)).toBe('xmlHttpRequestV2Beta');
    expect(pascalCase(input)).toBe('XmlHttpRequestV2Beta');
    expect(snakeCase(input)).toBe('xml_http_request_v2_beta');
    expect(kebabCase(input)).toBe('xml-http-request-v2-beta');
    expect(constantCase(input)).toBe('XML_HTTP_REQUEST_V2_BETA');
    expect(dotCase(input)).toBe('xml.http.request.v2.beta');
    expect(pathCase(input)).toBe('xml/http/request/v2/beta');
    expect(titleCase(input)).toBe('Xml Http Request V2 Beta');
    expect(sentenceCase(input)).toBe('Xml http request v2 beta');
  });
  it('handles the snake table from the design', () => {
    expect(snakeCase('iPhone11Pro')).toBe('i_phone11_pro');
    expect(snakeCase('crème brûlée')).toBe('crème_brûlée');
    expect(snakeCase("don't-stop")).toBe('dont_stop');
    expect(snakeCase('hello👩‍💻World')).toBe('hello_world');
    expect(snakeCase('___')).toBe('');
    expect(snakeCase('İstanbul')).toBe('i̇stanbul');
    expect(camelCase('ID')).toBe('id');
    expect(pascalCase('ID')).toBe('Id');
  });
  it('is idempotent on canonical identifiers', () => {
    for (const id of ['fooBarBaz', 'foo_bar_baz', 'foo-bar-baz', 'FooBarBaz', 'FOO_BAR_BAZ']) {
      expect(camelCase(camelCase(id))).toBe(camelCase(id));
      expect(snakeCase(snakeCase(id))).toBe(snakeCase(id));
      expect(kebabCase(kebabCase(id))).toBe(kebabCase(id));
    }
  });
  it('honours an explicit locale and never the machine locale', () => {
    expect(snakeCase('İSTANBUL', { locale: 'tr' })).toBe('istanbul');
    expect(constantCase('istanbul', { locale: 'tr' })).toBe('İSTANBUL');
    expect(constantCase('istanbul')).toBe('ISTANBUL');
    expect(constantCase('straße')).toBe('STRASSE');
  });
});

describe('capitalize / uncapitalize', () => {
  it('touches only the first grapheme', () => {
    expect(capitalize('hello, NASA!')).toBe('Hello, NASA!');
    expect(capitalize('éclair')).toBe('Éclair');
    expect(capitalize('éclair')).toBe('Éclair');
    expect(capitalize('👍 ok')).toBe('👍 ok');
    expect(capitalize('')).toBe('');
    expect(uncapitalize('Hello World')).toBe('hello World');
    expect(uncapitalize('')).toBe('');
  });
});

describe('malformed locale tags', () => {
  it('fall back to locale-independent casing instead of throwing', () => {
    expect(camelCase('hello world', { locale: 'xx_yy' })).toBe('helloWorld');
    expect(capitalize('hello', { locale: 'not a locale!' })).toBe('Hello');
  });
});
