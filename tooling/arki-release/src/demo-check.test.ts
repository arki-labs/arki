import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Candidate } from './candidate';
import type { ExecRunner, RunOutput } from './runners';
import type { ReleaseConfig } from './types';
import { candidateSchema } from './candidate';
import { DEMO_CHECK_ERROR_CODES, runDemoCheck } from './demo-check';

const config: Pick<ReleaseConfig, 'demos'> = {
  demos: [
    { name: 'shop', repo: 'arki-labs/shop', path: 'demos/shop' },
    { name: 'absent', repo: 'arki-labs/absent', path: 'demos/absent' },
  ],
};

let root: string;
let candidateDir: string;
let calls: { command: string; cwd: string }[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'arki-demo-check-'));
  calls = [];
  candidateDir = path.join(root, '.release', 'candidates', 'foundation-abcdef1');
  mkdirSync(path.join(candidateDir, 'tarballs'), { recursive: true });
  const bytes = Buffer.from('frozen tarball bytes of @arki/a');
  writeFileSync(path.join(candidateDir, 'tarballs', 'arki-a-0.2.0.tgz'), bytes);
  const candidate: Candidate = {
    wave: 'foundation',
    sourceCommit: 'abcdef1234567890',
    createdAt: '2026-10-17T00:00:00.000Z',
    packages: [
      {
        name: '@arki/a',
        version: '0.2.0',
        tarball: 'tarballs/arki-a-0.2.0.tgz',
        sha512: createHash('sha512').update(bytes).digest('hex'),
        publishOrder: 1,
      },
    ],
    checks: {},
  };
  writeFileSync(path.join(candidateDir, 'candidate.json'), JSON.stringify(candidate));
  mkdirSync(path.join(root, 'demos', 'shop'), { recursive: true });
  writeFileSync(
    path.join(root, 'demos', 'shop', 'package.json'),
    JSON.stringify({ name: 'shop', scripts: { 'arki:candidate': 'bun x.ts candidate' } }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A runner that answers `bun run arki:candidate` with `output` and records the call. */
function fakeRunner(output: RunOutput): ExecRunner {
  return async (command, args, options) => {
    calls.push({ command: [command, ...args].join(' '), cwd: options.cwd });
    return output;
  };
}

const report = (steps: { id: string; ok: boolean; detail: string }[]) => JSON.stringify({ steps });
const allPass = report(
  ['prepare', 'install', 'typecheck', 'test', 'build'].map(id => ({ id, ok: true, detail: 'ok' })),
);

function checks(): Candidate['checks'] {
  return candidateSchema.parse(JSON.parse(readFileSync(path.join(candidateDir, 'candidate.json'), 'utf8'))).checks;
}

const check = (demo: string, output: RunOutput) =>
  runDemoCheck({
    cwd: root,
    config,
    demo,
    candidateDir,
    runner: fakeRunner(output),
    now: () => new Date('2026-10-21T00:00:00.000Z'),
  });

/** Writes a one-package candidate next to `candidateDir`. */
function writeSibling(name: string, wave: string, createdAt: string): string {
  const dir = path.join(path.dirname(candidateDir), name);
  mkdirSync(path.join(dir, 'tarballs'), { recursive: true });
  const bytes = Buffer.from(`bytes of ${name}`);
  writeFileSync(path.join(dir, 'tarballs', 'b.tgz'), bytes);
  const sibling: Candidate = {
    wave,
    sourceCommit: 'abcdef1234567890',
    createdAt,
    packages: [{ name: '@arki/b', version: '0.1.0', tarball: 'tarballs/b.tgz', sha512: createHash('sha512').update(bytes).digest('hex'), publishOrder: 1 }],
    checks: {},
  };
  writeFileSync(path.join(dir, 'candidate.json'), JSON.stringify(sibling));
  return dir;
}

describe('runDemoCheck', () => {
  it('passes the newest candidate of every other wave along with its own', async () => {
    // Why: a demo uses several waves; no single wave's candidate holds them
    // all, so a lone candidate can never install it (the 2026-10-21 deadlock).
    // Older candidates of a wave, and others of its own wave, are left out.
    writeSibling('dot-kernel-old', 'dot-kernel', '2026-10-16T00:00:00.000Z');
    const newest = writeSibling('dot-kernel-new', 'dot-kernel', '2026-10-18T00:00:00.000Z');
    writeSibling('foundation-other', 'foundation', '2026-10-19T00:00:00.000Z');
    await check('shop', { code: 0, stdout: allPass, stderr: '' });
    expect(calls.map(c => c.command)).toEqual([`bun run arki:candidate ${candidateDir} ${newest}`]);
  });

  it('records success when every step of the demo passes against the candidate', async () => {
    // Why: demo-impact opens only on a `success` record; a demo that installs,
    // typechecks, tests and builds against the frozen tarballs is that proof.
    // Bun's own "$ bun ..." banner precedes the report, so only the last line is read.
    const envelope = await check('shop', { code: 0, stdout: `$ bun x.ts candidate\n${allPass}\n`, stderr: '' });
    expect(envelope.status).toBe('success');
    expect(calls).toEqual([
      { command: `bun run arki:candidate ${candidateDir}`, cwd: path.join(root, 'demos', 'shop') },
    ]);
    expect(checks()['demo:shop']).toMatchObject({ status: 'success', at: '2026-10-21T00:00:00.000Z' });
  });

  it('records a failure naming the failed step when the candidate breaks the demo', async () => {
    // Why: a candidate that breaks a demo must show up in the scorecard as a
    // failure with the step that broke, never as a pass or a silent skip.
    const stdout = report([
      { id: 'prepare', ok: true, detail: 'ok' },
      { id: 'install', ok: true, detail: 'ok' },
      { id: 'typecheck', ok: false, detail: "TS2305: Module '@arki/a' has no exported member 'gone'." },
    ]);
    const envelope = await check('shop', { code: 1, stdout, stderr: '' });
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(e => e.code)).toEqual([DEMO_CHECK_ERROR_CODES.stepFailed]);
    expect(envelope.errors[0]?.message).toContain('typecheck failed');
    expect(checks()['demo:shop']?.status).toBe('failure');
  });

  it('records a failure when the script prints no readable report', async () => {
    // Why: a crashed or missing `arki:candidate` script proves nothing; reading
    // its silence as a pass would let a broken demo through.
    const envelope = await check('shop', { code: 1, stdout: 'error: Script not found "arki:candidate"\n', stderr: '' });
    expect(envelope.errors.map(e => e.code)).toEqual([DEMO_CHECK_ERROR_CODES.noReport]);
    expect(checks()['demo:shop']?.status).toBe('failure');
  });

  it('defers, without running anything, when the demo folder is not on disk', async () => {
    // Why: nested demo repos are absent in CI clones. That is a warning to
    // clone the demo, not a crash and not a pass.
    const envelope = await check('absent', { code: 0, stdout: allPass, stderr: '' });
    expect(envelope.status).toBe('warning');
    expect(envelope.summary.outcome).toBe('skipped');
    expect(envelope.errors.map(e => e.code)).toEqual([DEMO_CHECK_ERROR_CODES.demoMissing]);
    expect(calls).toEqual([]);
    expect(checks()['demo:absent']?.status).toBe('deferred');
  });

  it('refuses an unregistered demo and records nothing', async () => {
    // Why: a typo in --demo must not write a check id demo-impact never reads.
    const envelope = await check('shpo', { code: 0, stdout: allPass, stderr: '' });
    expect(envelope.errors.map(e => e.code)).toEqual([DEMO_CHECK_ERROR_CODES.unknownDemo]);
    expect(calls).toEqual([]);
    expect(checks()).toEqual({});
  });
});
