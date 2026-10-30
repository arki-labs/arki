import { afterEach, expect, it, vi } from 'vitest';

import type { Fields } from './types.js';
import { json, logfmt, pretty } from './formatters.js';
import { createLogging } from './logging.js';
import { redact } from './processors.js';
import { lineSink, memorySink } from './sinks.js';

afterEach(() => vi.restoreAllMocks());

function circular(): Fields {
  const fields: Record<string, unknown> = { a: 1 };
  fields.self = fields;
  return fields as Fields;
}

it('a circular fields object never throws to the caller and is written by every formatter', () => {
  for (const format of [json(), logfmt(), pretty()]) {
    const lines: string[] = [];
    const logging = createLogging();
    logging.configure({ default: { level: 'info', channels: ['out'] }, channels: { out: lineSink(l => lines.push(l), { format }) } });
    expect(() => logging.getLogger('x').info('hi {a}', circular())).not.toThrow();
    expect(lines).toHaveLength(1);
  }
});

it('redact with a wildcard keeps a record whose fields are circular', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sink = memorySink();
  const logging = createLogging();
  logging.configure({ default: { level: 'info', channels: ['m'] }, channels: { m: sink }, processors: [redact(['*.a'])] });
  expect(() => logging.getLogger('x').info('hi', circular())).not.toThrow();
  expect(sink.records).toHaveLength(1);
});

it('a field getter that throws and a throwing sink never reach the caller', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const lines: string[] = [];
  const logging = createLogging();
  logging.configure({
    default: { level: 'info', channels: ['out', 'bad'] },
    channels: {
      out: lineSink(l => lines.push(l)),
      bad: { write: () => { throw new Error('sink down'); } },
    },
  });
  const hostile = {
    get boom(): never { throw new Error('getter'); },
  } as unknown as Fields;
  expect(() => logging.getLogger('x').info('hi', hostile)).not.toThrow();
  expect(() => logging.getLogger('x').info('hi', { n: 1n, s: Symbol('s'), f: () => 1 } as unknown as Fields)).not.toThrow();
});

