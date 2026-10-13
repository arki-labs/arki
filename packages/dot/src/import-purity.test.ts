/**
 * Importing Dot does nothing (`@arki/log` redesign RFC §1 and §9): no env read,
 * no write to stdout or stderr, no process listener. Logging and signals are
 * switched on by the app (`log()`, `hookSignals()`), never by an import.
 *
 * `packages/dot` does not depend on `@arki/ts`, so this is the same check as
 * `expectImportPure` from `@arki/ts/testing`, written inline: a fresh `bun`
 * process with an empty environment imports the entry points while every env
 * read, write and listener is recorded.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRIES = ['./index.ts', './log.ts', './plugin.ts'].map(entry => fileURLToPath(new URL(entry, import.meta.url)));

const SENTINEL = '__dot_import_purity__';

/** Runs in the subprocess. Records, imports, restores, then prints what it saw. */
function probeScript(entries: readonly string[]): string {
  return `
const seen = { envReads: [], listeners: [], writes: 0 };
const realEnv = process.env;
process.env = new Proxy(realEnv, {
  get(target, key, receiver) {
    if (typeof key === 'string') seen.envReads.push(key);
    return Reflect.get(target, key, receiver);
  },
});
const methods = ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'];
const realMethods = methods.map(name => process[name]);
methods.forEach((name, i) => {
  process[name] = function (event, ...rest) {
    seen.listeners.push(name + ':' + String(event));
    return realMethods[i].call(this, event, ...rest);
  };
});
const realOut = process.stdout.write;
const realErr = process.stderr.write;
process.stdout.write = function (...args) { seen.writes += 1; return realOut.apply(this, args); };
process.stderr.write = function (...args) { seen.writes += 1; return realErr.apply(this, args); };
${entries.map(entry => `await import(${JSON.stringify(entry)});`).join('\n')}
process.stdout.write = realOut;
process.stderr.write = realErr;
methods.forEach((name, i) => { process[name] = realMethods[i]; });
process.env = realEnv;
realOut.call(process.stdout, ${JSON.stringify(SENTINEL)} + JSON.stringify(seen) + '\\n');
`;
}

/** Imports `entries` in a fresh `bun` with an empty environment and returns what the probe saw. */
function probe(entries: readonly string[]): unknown {
  const result = spawnSync('bun', ['-e', probeScript(entries)], {
    // An empty environment: only what the runtime itself needs to start.
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- building the scrubbed environment of the subprocess
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const detail = `\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
  expect(result.status, detail).toBe(0);
  const line = result.stdout.split('\n').find(text => text.startsWith(SENTINEL));
  expect(line, detail).toBeDefined();
  return JSON.parse((line ?? '').slice(SENTINEL.length));
}

describe('import purity', () => {
  it('importing @arki/dot, @arki/dot/log and @arki/dot/plugin reads no env, writes nothing and registers no listener', () => {
    expect(probe(ENTRIES)).toEqual({ envReads: [], listeners: [], writes: 0 });
  });

  it('the probe does see an env read, a listener and a write, so the test above can fail', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dot-purity-'));
    try {
      const impure = path.join(dir, 'impure.mjs');
      writeFileSync(impure, "void process.env.DOT_PROBE;\nprocess.on('exit', () => {});\nprocess.stderr.write('x');\n");
      expect(probe([impure])).toEqual({ envReads: ['DOT_PROBE'], listeners: ['on:exit'], writes: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
