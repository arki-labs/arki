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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { program } from './index.js';

const GUIDE = readFileSync(fileURLToPath(new URL('../../docs/agent-guide.md', import.meta.url)), 'utf8');
const KERNEL = (file: string): string => JSON.stringify(fileURLToPath(new URL(`../${file}`, import.meta.url)));

/** The app the paths are checked against: one provider, one consumer, one registered service. */
const APP_SOURCE = `
import { defineApp } from ${KERNEL('define-app.ts')};
import { infra } from ${KERNEL('unit-contract.ts')};

const database = infra({
  name: 'database',
  provides: { db: () => ({ query: (sql: string) => Promise.resolve([sql]) }) },
});
const reports = infra({
  name: 'reports',
  needs: { db: database.provides.db },
  configure: ctx => {
    ctx.registerService('reports', 'custom');
  },
  provides: { reports: ({ db }) => ({ daily: () => db.query('daily') }) },
});
export default defineApp('jq-paths').infra(database).infra(reports);
`;

const workDir = mkdtempSync(path.join(tmpdir(), 'dot-json-paths-'));
const appFile = path.join(workDir, 'app.ts');
writeFileSync(appFile, APP_SOURCE);
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Run `dot` the way an agent does, stdout piped, and parse what it prints the way `jq` would. */
async function dotJson(argv: string[]): Promise<unknown> {
  let written = '';
  const code = await program.main(argv, {
    stdout: text => {
      written += text;
    },
  });
  expect({ argv, code }).toEqual({ argv, code: 0 });
  const parsed: unknown = JSON.parse(written);
  return parsed;
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
    const envelope = await dotJson(['explain', '--app', appFile]);

    const filters = guideFilters('explain');
    expect(filters.length).toBeGreaterThanOrEqual(4);
    for (const filter of filters) {
      expect({ filter, resolves: resolves(envelope, pathSegments(filter)) }).toEqual({ filter, resolves: true });
    }
  });

  it('dot doctor --json: every guide filter resolves on the real envelope', async () => {
    const envelope = await dotJson(['doctor', '--app', appFile]);

    const filters = guideFilters('doctor');
    expect(filters.length).toBeGreaterThanOrEqual(5);
    for (const filter of filters) {
      expect({ filter, resolves: resolves(envelope, pathSegments(filter)) }).toEqual({ filter, resolves: true });
    }
  });

  it('.data is the payload itself: .data.manifest and .data.diagnostics do not exist', async () => {
    const explained = await dotJson(['explain', '--app', appFile]);
    const doctored = await dotJson(['doctor', '--app', appFile]);

    expect(resolves(explained, ['data', 'manifestVersion'])).toBe(true);
    expect(resolves(explained, ['data', 'manifest'])).toBe(false);
    expect(resolves(doctored, ['data', 'snapshotVersion'])).toBe(true);
    expect(resolves(doctored, ['data', 'diagnostics'])).toBe(false);
  });
});

describe('dot new --dry-run --json: the fields the guide documents', () => {
  it('prints .data.app + .data.operations[] with path/action/contentHash/contentBytes/reason, and writes nothing', async () => {
    const envelope = await dotJson(['new', 'demo', '--dry-run', '--json', '--cwd', workDir]);

    for (const fieldPath of [
      ['ok'],
      ['command'],
      ['data', 'app', 'name'],
      ['data', 'app', 'target'],
      ['data', 'nextSteps'],
      ['meta', 'dryRun'],
    ]) {
      expect({ fieldPath, resolves: resolves(envelope, fieldPath) }).toEqual({ fieldPath, resolves: true });
    }
    for (const field of ['path', 'action', 'contentHash', 'contentBytes', 'reason']) {
      expect({ field, resolves: resolves(envelope, ['data', 'operations', '[]', field]) }).toEqual({
        field,
        resolves: true,
      });
    }
    expect(resolves(envelope, ['data', 'operations', '[]'])).toBe(true);
    expect(existsSync(path.join(workDir, 'demo'))).toBe(false);
  });
});
