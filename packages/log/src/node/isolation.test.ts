import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('../../test/fixtures/closed-stdout.mjs', import.meta.url));
const asyncFixture = fileURLToPath(new URL('../../test/fixtures/async-providers.mjs', import.meta.url));

describe('real broken output descriptors', () => {
  it.each(['tick', 'exit'])('a closed stdout cannot terminate the application during %s flush', mode => {
    const bundle = spawnSync('bun', ['build', fixture, '--target=node', '--format=esm'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(bundle.status, bundle.stderr).toBe(0);
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', bundle.stdout, mode], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    if (mode === 'tick') expect(child.stderr).toContain('survived');
  });
});

it('observes asynchronous JavaScript provider and diagnostic rejections without replacing business promises', () => {
  const bundle = spawnSync('bun', ['build', asyncFixture, '--target=node', '--format=esm'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(bundle.status, bundle.stderr).toBe(0);
  const child = spawnSync(
    process.execPath,
    ['--unhandled-rejections=strict', '--input-type=module', '--eval', bundle.stdout],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('async observation faults contained');
});
