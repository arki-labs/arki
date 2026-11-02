/**
 * `@arki/mail/dot` loads in an app that never installed `@arki/journal`. Why: the journal is an
 * optional peer, needed only for queued mail (`@arki/mail/outbox`). When the `dot` entry
 * value-imported the outbox, every app that used `mail()` had to install the journal: a demo that
 * only sends mail failed to start with "Cannot find package '@arki/journal'".
 *
 * The check runs the BUILT entry the way an app does (turbo builds before `test`). It copies `dist/`
 * into a fresh `node_modules/@arki/mail` outside the repo, links mail's dependencies and peers beside
 * it, leaves the journal out, and imports each entry in a new Node process.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  peerDependencies: z.record(z.string(), z.string()),
});

/** The folder bun installed `name` into, found the way Node finds it: up from this package. */
function installedDir(name: string): string {
  let dir = packageRoot;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${name} is not installed above ${packageRoot}`);
    dir = parent;
  }
}

let appDir: string;

beforeAll(() => {
  appDir = mkdtempSync(path.join(tmpdir(), 'arki-mail-no-journal-'));
  const modules = path.join(appDir, 'node_modules');
  const mailDir = path.join(modules, '@arki', 'mail');
  mkdirSync(mailDir, { recursive: true });
  cpSync(path.join(packageRoot, 'dist'), path.join(mailDir, 'dist'), { recursive: true });
  cpSync(path.join(packageRoot, 'package.json'), path.join(mailDir, 'package.json'));
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')));
  // Every dependency and every peer is installed except `@arki/journal`, so only its absence is tested.
  const peers = Object.keys(manifest.peerDependencies).filter(name => name !== '@arki/journal');
  for (const name of [...Object.keys(manifest.dependencies), ...peers]) {
    const target = path.join(modules, name);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(installedDir(name), target, 'dir');
  }
  writeFileSync(
    path.join(appDir, 'load.mjs'),
    'const entry = await import(process.argv[2]);\nconsole.log(Object.keys(entry).sort().join(","));\n',
  );
});

afterAll(() => {
  rmSync(appDir, { recursive: true, force: true });
});

function load(specifier: string) {
  return spawnSync(process.execPath, ['load.mjs', specifier], { cwd: appDir, encoding: 'utf8' });
}

describe('@arki/mail/dot in an app without @arki/journal', () => {
  it('the journal is really absent here: the outbox entry, which needs it, cannot load', () => {
    const result = load('@arki/mail/outbox');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Cannot find package '@arki\/journal'/);
  });

  it('loads and gives mail()', () => {
    const result = load('@arki/mail/dot');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('mail');
  });
});
