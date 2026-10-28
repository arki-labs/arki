import { describe, expect, expectTypeOf, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import * as base64 from './base64.js';
import * as string from './index.js';

import {
  base64ToBytes,
  byteLength,
  bytesToBase64,
  fromBase64,
  InvalidBase64,
  InvalidUtf8,
  toBase64,
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
    expect(orThrow(toBase64(text))).toBe(encoded);
    expect(fromBase64(encoded)).toBe(text);
    expect(orThrow(toBase64(text, { alphabet: 'url' }))).toBe(encoded.replaceAll('=', ''));
    expect(fromBase64(encoded.replaceAll('=', ''), { alphabet: 'url' })).toBe(text);
  });
});

describe('text round-trips', () => {
  it.each(['crème brûlée 👋', '\u0000nul', '﻿bom first', '👨‍👩‍👧‍👦🇷🇴', 'á', '你好'])('%j', text => {
    expect(fromBase64(orThrow(toBase64(text)))).toBe(text);
    expect(fromBase64(orThrow(toBase64(text, { alphabet: 'url' })), { alphabet: 'url' })).toBe(text);
    expect(orThrow(utf8Decode(orThrow(utf8Encode(text))))).toBe(text);
    expect(byteLength(text)).toBe(orThrow(utf8Encode(text)).length);
    expect(byteLength(text)).toBe(new TextEncoder().encode(text).length);
  });
  it('matches TextEncoder output', () => {
    const sample = 'Ünïcödé 🚀 текст';
    expect([...orThrow(utf8Encode(sample))]).toEqual([...new TextEncoder().encode(sample)]);
  });
  it('rejects unpaired surrogates', () => {
    expect(InvalidUtf8.is(toBase64('\uD83D'))).toBe(true);
    expect(InvalidUtf8.is(byteLength('x\uDC00'))).toBe(true);
  });
  it('encodes an url-safe alphabet', () => {
    expect(orThrow(toBase64('ûÿ', { alphabet: 'url' }))).not.toMatch(/[+/=]/u);
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]), { alphabet: 'url' })).toBe('-_8');
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]), { alphabet: 'url', padding: 'required' })).toBe('-_8=');
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]), { padding: 'forbidden' })).toBe('+/8');
  });
});

describe('byte round-trips', () => {
  it('every byte value and every length up to 300', () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect([...orThrow(base64ToBytes(bytesToBase64(all)))]).toEqual([...all]);
    for (let size = 0; size <= 300; size += 1) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 37 + size) % 256);
      for (const options of [{}, { alphabet: 'url' as const }]) {
        expect([...orThrow(base64ToBytes(bytesToBase64(bytes, options), options))]).toEqual([...bytes]);
      }
    }
  });
  it('encodes only a subarray view', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(bytesToBase64(backing.subarray(2, 4))).toBe(bytesToBase64(new Uint8Array([3, 4])));
  });
  it('handles multi-megabyte input', () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(0xab);
    expect(orThrow(base64ToBytes(bytesToBase64(big))).length).toBe(big.length);
    expect(orThrow(utf8Decode(orThrow(utf8Encode('x'.repeat(1_000_000))))).length).toBe(1_000_000);
  });
  it('re-encoding accepted input is canonical', () => {
    for (const encoded of ['Zg==', 'Zm8=', 'Zm9v', '+/8=']) {
      expect(bytesToBase64(orThrow(base64ToBytes(encoded)))).toBe(encoded);
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
    expect(InvalidBase64.is(base64ToBytes(encoded, options))).toBe(true);
    expect(InvalidBase64.is(fromBase64(encoded, options))).toBe(true);
  });
  it('accepts url input without padding by default', () => {
    expect(fromBase64('Zg', { alphabet: 'url' })).toBe('f');
  });
  it('separates binary from text decoding', () => {
    expect([...orThrow(base64ToBytes('/w=='))]).toEqual([255]);
    expect(InvalidUtf8.is(fromBase64('/w=='))).toBe(true);
  });
  it.each([
    [[0xc0, 0x80], 'overlong'],
    [[0xe0, 0x80, 0x80], 'overlong'],
    [[0xed, 0xa0, 0x80], 'surrogate'],
    [[0xf4, 0x90, 0x80, 0x80], 'beyond U+10FFFF'],
    [[0xe2, 0x82], 'truncated'],
    [[0x80], 'stray continuation'],
    [[0xff], 'invalid lead'],
    [[0xc2, 0x20], 'invalid two-byte continuation'],
    [[0xe2, 0x82, 0x20], 'invalid three-byte continuation'],
    [[0xf0, 0x90, 0x80, 0x20], 'invalid four-byte continuation'],
    [[0xf0, 0x80, 0x80, 0x80], 'overlong four-byte sequence'],
    [[0xf0, 0x90, 0x80], 'truncated four-byte sequence'],
  ])('utf8Decode rejects %j (%s)', bytes => {
    expect(InvalidUtf8.is(utf8Decode(new Uint8Array(bytes)))).toBe(true);
  });
});

it('returns exact canonical failures and narrows successes without leaking input', () => {
  type Utf8Failure = ReturnType<typeof InvalidUtf8>;
  type Base64Failure = ReturnType<typeof InvalidBase64>;
  expectTypeOf<ReturnType<typeof byteLength>>().toEqualTypeOf<number | Utf8Failure>();
  expectTypeOf<ReturnType<typeof utf8Encode>>().toEqualTypeOf<Uint8Array<ArrayBuffer> | Utf8Failure>();
  expectTypeOf<ReturnType<typeof utf8Decode>>().toEqualTypeOf<string | Utf8Failure>();
  expectTypeOf<ReturnType<typeof base64ToBytes>>().toEqualTypeOf<Uint8Array<ArrayBuffer> | Base64Failure>();
  expectTypeOf<ReturnType<typeof toBase64>>().toEqualTypeOf<string | Utf8Failure>();
  expectTypeOf<ReturnType<typeof fromBase64>>().toEqualTypeOf<string | Utf8Failure | Base64Failure>();
  const value = fromBase64('private input!');
  if (isFailure(value)) {
    expectTypeOf(value).toEqualTypeOf<Utf8Failure | Base64Failure>();
    expect(value.status).toBe(400);
    expect(value.remediation).toBeTruthy();
    expect(value.data).toBeUndefined();
    expect(value.cause).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain('private input!');
  } else {
    expectTypeOf(value).toEqualTypeOf<string>();
    throw new Error('Expected failure');
  }
});

it('keeps both canonical failure envelopes safe and actionable', () => {
  for (const value of [utf8Encode('secret\uD800'), base64ToBytes('secret!')]) {
    expect(isFailure(value)).toBe(true);
    if (!isFailure(value)) throw new Error('Expected failure');
    expect(value.status).toBe(400);
    expect(value.remediation).toBeTruthy();
    expect(value.data).toBeUndefined();
    expect(value.cause).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain('secret');
  }
});

it('exposes one canonical decoder without the retired compatibility alias', () => {
  expect(base64).not.toHaveProperty('tryFromBase64');
  expect(string).not.toHaveProperty('tryFromBase64');
  expectTypeOf<keyof typeof base64>().extract<'tryFromBase64'>().toBeNever();
  expectTypeOf<keyof typeof string>().extract<'tryFromBase64'>().toBeNever();
});
