import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SourceSnapshot } from './snapshot';
import { createSourceSnapshot } from './snapshot';

let repo: string;
let snapshot: SourceSnapshot | undefined;

function write(relative: string, contents: string): void {
  const target = path.join(repo, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
  });
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'arki-snapshot-test-'));
  git('init', '-q', '-b', 'main');
  write('.gitignore', 'dist/\n');
  write('package.json', '{"name":"root"}\n');
  write('arki.release.config.ts', 'export default { waves: ["committed"] };\n');
  write('packages/clean/package.json', '{"name":"@arki/clean","version":"0.0.1"}\n');
  write('packages/edited/package.json', '{"name":"@arki/edited","version":"0.0.1"}\n');
  write('packages/ui/chat/package.json', '{"name":"@arki/chat","version":"0.0.1"}\n');
  write('tooling/config/package.json', '{"name":"@arki/config-pkg","version":"0.0.1"}\n');
  write('apps/private/secret.ts', 'never exported\n');
  write('SECURITY.md', 'committed policy\n');
  write('CONTRIBUTING.md', 'committed guide\n');
  write('.github/ISSUE_TEMPLATE/bug.yml', 'name: Bug\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  write('packages/clean/dist/index.js', 'built clean\n');
  write('packages/edited/dist/index.js', 'built from uncommitted source\n');
  write('packages/ui/chat/dist/index.js', 'built chat\n');
  write('tooling/config/dist/index.js', 'built config\n');
});

afterEach(async () => {
  await snapshot?.cleanup();
  snapshot = undefined;
  rmSync(repo, { recursive: true, force: true });
});

describe('createSourceSnapshot', () => {
  it('holds committed content, not a sibling session’s uncommitted edits', async () => {
    // The 2026-10-13 case: someone bumps a version and edits the waves without committing.
    write('packages/edited/package.json', '{"name":"@arki/edited","version":"0.0.2"}\n');
    write('arki.release.config.ts', 'export default { waves: ["uncommitted"] };\n');

    snapshot = await createSourceSnapshot({ rootCwd: repo });

    expect(readFileSync(path.join(snapshot.dir, 'packages/edited/package.json'), 'utf8')).toContain('0.0.1');
    expect(readFileSync(path.join(snapshot.dir, 'arki.release.config.ts'), 'utf8')).toContain('committed');
    // The exporter copies these from the snapshot; without them every candidate crashed.
    expect(readFileSync(path.join(snapshot.dir, 'SECURITY.md'), 'utf8')).toBe('committed policy\n');
    expect(existsSync(path.join(snapshot.dir, '.github/ISSUE_TEMPLATE/bug.yml'))).toBe(true);
    expect(existsSync(path.join(snapshot.dir, 'apps'))).toBe(false);
  });

  it('copies dist/ only for packages that match the commit, nested ones included', async () => {
    write('packages/edited/src/index.ts', 'uncommitted new file\n');

    snapshot = await createSourceSnapshot({ rootCwd: repo });

    expect(readFileSync(path.join(snapshot.dir, 'packages/clean/dist/index.js'), 'utf8')).toBe('built clean\n');
    expect(readFileSync(path.join(snapshot.dir, 'packages/ui/chat/dist/index.js'), 'utf8')).toBe('built chat\n');
    expect(readFileSync(path.join(snapshot.dir, 'tooling/config/dist/index.js'), 'utf8')).toBe('built config\n');
    // Its build may come from the uncommitted source, so it must not ship.
    expect(existsSync(path.join(snapshot.dir, 'packages/edited/dist'))).toBe(false);
    expect(existsSync(path.join(snapshot.dir, 'packages/edited/src'))).toBe(false);
    expect(snapshot.dirtyPackages).toEqual(['packages/edited']);
  });

  it('ignores Markdown edits when deciding on dist/, but still ships the committed README', async () => {
    write('packages/clean/README.md', 'committed\n');
    git('add', '.');
    git('commit', '-qm', 'readme');
    write('packages/clean/README.md', 'a docs sweep in progress\n');

    snapshot = await createSourceSnapshot({ rootCwd: repo });

    expect(snapshot.dirtyPackages).toEqual([]);
    expect(existsSync(path.join(snapshot.dir, 'packages/clean/dist/index.js'))).toBe(true);
    expect(readFileSync(path.join(snapshot.dir, 'packages/clean/README.md'), 'utf8')).toBe('committed\n');
  });

  it('removes its directory on cleanup', async () => {
    snapshot = await createSourceSnapshot({ rootCwd: repo });
    const dir = snapshot.dir;
    await snapshot.cleanup();
    expect(existsSync(dir)).toBe(false);
  });
});
