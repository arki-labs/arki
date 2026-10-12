import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  byteLength,
  bytesToBase64,
  fromBase64,
  toBase64,
  tryFromBase64,
  utf8Decode,
  utf8Encode,
} from './base64.js';

describe('RFC 4648 vectors', () => {
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ])('%j ⇄ %j', (text, encoded) => {
    expect(toBase64(text)).toBe(encoded);
    expect(fromBase64(encoded)).toBe(text);
    expect(toBase64(text, { alphabet: 'url' })).toBe(encoded.replaceAll('=', ''));
    expect(fromBase64(encoded.replaceAll('=', ''), { alphabet: 'url' })).toBe(text);
  });
});

describe('text round-trips', () => {
  it.each(['crème brûlée 👋', '\u0000nul', '﻿bom first', '👨‍👩‍👧‍👦🇷🇴', 'á', '你好'])('%j', text => {
    expect(fromBase64(toBase64(text))).toBe(text);
    expect(fromBase64(toBase64(text, { alphabet: 'url' }), { alphabet: 'url' })).toBe(text);
    expect(utf8Decode(utf8Encode(text))).toBe(text);
    expect(byteLength(text)).toBe(utf8Encode(text).length);
    expect(byteLength(text)).toBe(new TextEncoder().encode(text).length);
  });
  it('matches TextEncoder output', () => {
    const sample = 'Ünïcödé 🚀 текст';
    expect([...utf8Encode(sample)]).toEqual([...new TextEncoder().encode(sample)]);
  });
  it('rejects unpaired surrogates', () => {
    expect(() => toBase64('\uD83D')).toThrow(TypeError);
    expect(() => byteLength('x\uDC00')).toThrow(TypeError);
  });
  it('encodes an url-safe alphabet', () => {
    expect(toBase64('ûÿ', { alphabet: 'url' })).not.toMatch(/[+/=]/u);
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]), { alphabet: 'url' })).toBe('-_8');
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]), { alphabet: 'url', padding: 'required' })).toBe('-_8=');
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]), { padding: 'forbidden' })).toBe('+/8');
  });
});

describe('byte round-trips', () => {
  it('every byte value and every length up to 300', () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect([...base64ToBytes(bytesToBase64(all))]).toEqual([...all]);
    for (let size = 0; size <= 300; size += 1) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 37 + size) % 256);
      for (const options of [{}, { alphabet: 'url' as const }]) {
        expect([...base64ToBytes(bytesToBase64(bytes, options), options)]).toEqual([...bytes]);
      }
    }
  });
  it('encodes only a subarray view', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(bytesToBase64(backing.subarray(2, 4))).toBe(bytesToBase64(new Uint8Array([3, 4])));
  });
  it('handles multi-megabyte input', () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(0xab);
    expect(base64ToBytes(bytesToBase64(big)).length).toBe(big.length);
    expect(utf8Decode(utf8Encode('x'.repeat(1_000_000))).length).toBe(1_000_000);
  });
  it('re-encoding accepted input is canonical', () => {
    for (const encoded of ['Zg==', 'Zm8=', 'Zm9v', '+/8=']) {
      expect(bytesToBase64(base64ToBytes(encoded))).toBe(encoded);
    }
  });
});

describe('strict decoding', () => {
  it.each([
    ['Zg', {}],
    ['Zg==', { alphabet: 'url' }],
    ['Zh==', {}],
    ['A', {}],
    ['=Zg=', {}],
    ['Zg===', {}],
    ['Zm 9v', {}],
    ['Zm9v\n', {}],
    ['-_8=', {}],
    ['+/8', { alphabet: 'url' }],
    ['Zm9', { alphabet: 'url', padding: 'required' }],
    ['A', { alphabet: 'url' }],
  ] as const)('rejects %j with %j', (encoded, options) => {
    expect(() => base64ToBytes(encoded, options)).toThrow(SyntaxError);
    expect(tryFromBase64(encoded, options)).toBeNull();
  });
  it('accepts url input without padding by default', () => {
    expect(fromBase64('Zg', { alphabet: 'url' })).toBe('f');
  });
  it('separates binary from text decoding', () => {
    expect([...base64ToBytes('/w==')]).toEqual([255]);
    expect(() => fromBase64('/w==')).toThrow(TypeError);
    expect(tryFromBase64('/w==')).toBeNull();
  });
  it.each([
    [[0xc0, 0x80], 'overlong'],
    [[0xe0, 0x80, 0x80], 'overlong'],
    [[0xed, 0xa0, 0x80], 'surrogate'],
    [[0xf4, 0x90, 0x80, 0x80], 'beyond U+10FFFF'],
    [[0xe2, 0x82], 'truncated'],
    [[0x80], 'stray continuation'],
    [[0xff], 'invalid lead'],
  ])('utf8Decode rejects %j (%s)', bytes => {
    expect(() => utf8Decode(new Uint8Array(bytes))).toThrow(TypeError);
  });
});
