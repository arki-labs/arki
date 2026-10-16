/**
 * The agent guide's jq paths resolve against the real `--json` output.
 *
 * Why this test exists: agents copy the `jq` filters in
 * `docs/agent-guide.md` verbatim. The guide once told them to read
 * `.data.manifest` and `.data.diagnostics`, paths that never existed — `.data`
 * IS the manifest (explain) and IS the diagnostics snapshot (doctor). Every
 * filter returned `null` and nothing failed. This test reads the filters out
 * of the guide and walks each one against the JSON the CLI prints, so a wrong
 * path fails here instead of in an agent's session.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { plugin } from '../plugin-contract.js';
import { runDoctor, runExplain } from './index.js';
import { runNew } from './new.js';

const FROZEN_NOW = () => new Date('2026-01-01T00:00:00.000Z');
const GUIDE = readFileSync(fileURLToPath(new URL('../../docs/agent-guide.md', import.meta.url)), 'utf8');

/** The app the paths are checked against: one provider, one consumer, one registered service. */
const appBuilder = () => {
  const database = plugin({ name: 'database', provides: { db: () => ({ query: (sql: string) => Promise.resolve([sql]) }) } });
  const reports = plugin({
    name: 'reports',
    needs: { db: database.provides.db },
    configure: ctx => {
      ctx.registerService('reports', 'custom');
    },
    provides: { reports: ({ db }) => ({ daily: () => db.query('daily') }) },
  });
  return defineApp('jq-paths').use(database).use(reports);
};

/** Capture what the CLI writes to stdout and parse it the way `jq` would. */
function capture(): { out: (line: string) => void; json: () => unknown } {
  let written = '';
  return {
    out: line => {
      written += line;
    },
    json: () => {
      const parsed: unknown = JSON.parse(written);
      return parsed;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `.data.plugins[].name` → `['data', 'plugins', '[]', 'name']`. Stops at the first non-path token. */
function pathSegments(filter: string): string[] {
  const leading = /^\.[a-z_][\w.[\]]*/i.exec(filter.trim());
  if (!leading) throw new Error(`jq filter does not start with a path: ${filter}`);
  return leading[0]
    .slice(1)
    .split('.')
    .flatMap(part => (part.endsWith('[]') ? [part.slice(0, -2), '[]'] : [part]));
}

/** True when every segment exists, the way jq would find a value (`[]` needs an array). */
function resolves(value: unknown, segments: readonly string[]): boolean {
  const [head, ...rest] = segments;
  if (head === undefined) return value !== undefined;
  if (head === '[]') return Array.isArray(value) && value.every(item => resolves(item, rest));
  return isRecord(value) && head in value && resolves(value[head], rest);
}

/** Every `dot <command> --json | jq '<filter>'` in the guide, for one command. */
function guideFilters(command: 'explain' | 'doctor'): string[] {
  const pattern = new RegExp(`dot ${command} --json \\| jq (?:-e )?'([^']+)'`, 'g');
  return [...GUIDE.matchAll(pattern)].map(match => match[1] ?? '');
}

describe('agent guide jq paths', () => {
  it('dot explain --json: every guide filter resolves on the real envelope', async () => {
    const stdout = capture();
    await runExplain(appBuilder(), { json: true, out: stdout.out, now: FROZEN_NOW });
    const envelope = stdout.json();

    const filters = guideFilters('explain');
    expect(filters.length).toBeGreaterThanOrEqual(4);
    for (const filter of filters) {
      expect({ filter, resolves: resolves(envelope, pathSegments(filter)) }).toEqual({ filter, resolves: true });
    }
  });

  it('dot doctor --json: every guide filter resolves on the real envelope', async () => {
    const stdout = capture();
    await runDoctor(appBuilder(), { json: true, out: stdout.out, now: FROZEN_NOW });
    const envelope = stdout.json();

    const filters = guideFilters('doctor');
    expect(filters.length).toBeGreaterThanOrEqual(5);
    for (const filter of filters) {
      expect({ filter, resolves: resolves(envelope, pathSegments(filter)) }).toEqual({ filter, resolves: true });
    }
  });

  it('.data is the payload itself: .data.manifest and .data.diagnostics do not exist', async () => {
    const explainOut = capture();
    await runExplain(appBuilder(), { json: true, out: explainOut.out, now: FROZEN_NOW });
    const doctorOut = capture();
    await runDoctor(appBuilder(), { json: true, out: doctorOut.out, now: FROZEN_NOW });

    expect(resolves(explainOut.json(), ['data', 'manifestVersion'])).toBe(true);
    expect(resolves(explainOut.json(), ['data', 'manifest'])).toBe(false);
    expect(resolves(doctorOut.json(), ['data', 'snapshotVersion'])).toBe(true);
    expect(resolves(doctorOut.json(), ['data', 'diagnostics'])).toBe(false);
  });
});

describe('dot new --dry-run --json: the fields the guide documents', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dot-json-paths-'));
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('prints app + operations with path/action/contentHash/contentBytes/reason, and writes nothing', async () => {
    const stdout = capture();
    await runNew({ name: 'demo', cwd, dryRun: true, json: true, out: stdout.out, now: FROZEN_NOW });
    const envelope = stdout.json();

    for (const fieldPath of [['status'], ['command'], ['app', 'name'], ['app', 'target'], ['errors']]) {
      expect({ fieldPath, resolves: resolves(envelope, fieldPath) }).toEqual({ fieldPath, resolves: true });
    }
    for (const field of ['path', 'action', 'contentHash', 'contentBytes', 'reason']) {
      expect({ field, resolves: resolves(envelope, ['operations', '[]', field]) }).toEqual({ field, resolves: true });
    }
    expect(resolves(envelope, ['operations', '[]'])).toBe(true);
    expect(existsSync(path.join(cwd, 'demo'))).toBe(false);
  });
});
