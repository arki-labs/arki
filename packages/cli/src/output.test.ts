/**
 * Output mode decides who reads stdout: a person on a terminal, or a program
 * on a pipe. A wrong default breaks every agent that pipes a command.
 */
import { describe, expect, it } from 'vitest';

import { okEnvelope } from './envelope.js';
import { parseFields, pickFields, renderText, resolveMode, writeEnvelope } from './output.js';
import { createUi } from './ui.js';

const context = { command: ['ping'], version: '1.0.0', durationMs: 0, dryRun: false, docsUrl: undefined };

describe('resolveMode', () => {
  it('is text on a terminal and json on a pipe by default', () => {
    expect(resolveMode({ json: false, output: undefined, env: {}, tty: true })).toBe('text');
    expect(resolveMode({ json: false, output: undefined, env: {}, tty: false })).toBe('json');
  });

  it('lets -o override the terminal, and --json override -o', () => {
    expect(resolveMode({ json: false, output: 'text', env: {}, tty: false })).toBe('text');
    expect(resolveMode({ json: true, output: 'text', env: {}, tty: true })).toBe('json');
  });

  it('reads ARKI_OUTPUT below the flags, and ignores a value that is not a mode', () => {
    expect(resolveMode({ json: false, output: undefined, env: { ARKI_OUTPUT: 'ndjson' }, tty: true })).toBe('ndjson');
    expect(resolveMode({ json: false, output: 'text', env: { ARKI_OUTPUT: 'json' }, tty: false })).toBe('text');
    expect(resolveMode({ json: false, output: undefined, env: { ARKI_OUTPUT: 'yaml' }, tty: true })).toBe('text');
  });
});

describe('--fields', () => {
  it('keeps the dot paths asked for, per element of an array, and omits missing ones', () => {
    const data = { items: [{ id: 1, owner: { name: 'a', mail: 'x' } }, { id: 2 }], total: 2 };
    expect(pickFields(data, parseFields('items.id,items.owner.name,nope'))).toEqual({
      items: [{ id: 1, owner: { name: 'a' } }, { id: 2 }],
    });
  });
});

function ignore(): void {
  // stderr is not under test here.
}

function written(mode: 'text' | 'json' | 'ndjson', data: unknown) {
  const out: string[] = [];
  const ui = createUi({ mode, quiet: false, stdout: text => out.push(text), stderr: ignore });
  writeEnvelope(okEnvelope(data, context), {
    mode,
    name: 'tool',
    ui,
    render: undefined,
    stdout: text => out.push(text),
    stderr: ignore,
  });
  return out;
}

describe('writeEnvelope', () => {
  it('ndjson writes one line per item, then the envelope without data', () => {
    const lines = written('ndjson', { items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3] ?? '')).toEqual({ ok: true, command: ['ping'], error: null, meta: expect.anything() });
  });

  it('ndjson without items writes the envelope only', () => {
    expect(written('ndjson', { count: 1 })).toHaveLength(1);
  });

  it('text renders an array of objects as a padded table', () => {
    expect(
      renderText([
        { name: 'db', ok: true },
        { name: 'queue', ok: false },
      ]),
    ).toBe('name   ok\ndb     true\nqueue  false');
  });

  it('text renders an object as key: value lines', () => {
    expect(written('text', { embedded: 200, label: 'latest' })).toEqual(['embedded: 200\nlabel: latest\n']);
  });
});
