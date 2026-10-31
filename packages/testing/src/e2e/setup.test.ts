import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { defineStack, service } from '../stack/index.js';
import { stackSetup } from './setup.js';

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

/** A stack with one service that records whether it is up. */
function countedStack() {
  const live = new Set<string>();
  const probe = service<{ readonly up: true }>({
    name: 'probe',
    scope: 'run',
    async start(ctx) {
      live.add(ctx.runId);
      return { value: { up: true }, stop: async () => void live.delete(ctx.runId) };
    },
  });
  return { live, stack: defineStack({ services: { probe }, env: () => ({}) }) };
}

async function workFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'arki-setup-test-'));
  folders.push(folder);
  return folder;
}

describe('stackSetup', () => {
  it('stops the started stack when the build fails, so no container is left running', async () => {
    const { live, stack } = countedStack();
    const cwd = await workFolder();
    const setup = stackSetup(stack, {
      build: { command: ['node', '-e', 'process.exit(3)'], cwd, inputs: [], output: path.join(cwd, '.output', 'server', 'index.mjs') },
    });
    await expect(setup()).rejects.toThrow(/BUILD_FAILED/);
    expect([...live]).toEqual([]);
  });

  it('stops the started stack when the build succeeds but its output cannot be copied', async () => {
    const { live, stack } = countedStack();
    const cwd = await workFolder();
    const setup = stackSetup(stack, {
      build: { command: ['node', '-e', ''], cwd, inputs: [], output: path.join(cwd, 'missing', 'server', 'index.mjs') },
    });
    await expect(setup()).rejects.toThrow();
    expect([...live]).toEqual([]);
  });

  it('keeps the stack up and returns a teardown that stops it when the build works', async () => {
    const { live, stack } = countedStack();
    const cwd = await workFolder();
    const output = path.join(cwd, '.output', 'server', 'index.mjs');
    const setup = stackSetup(stack, {
      build: {
        command: ['node', '-e', `require('node:fs').mkdirSync(${JSON.stringify(path.dirname(output))}, { recursive: true }); require('node:fs').writeFileSync(${JSON.stringify(output)}, '')`],
        cwd,
        inputs: [],
        output,
      },
    });
    const teardown = await setup();
    expect(live.size).toBe(1);
    await teardown();
    expect([...live]).toEqual([]);
  });
});
