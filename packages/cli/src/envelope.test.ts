/**
 * The envelope is the contract with every script and agent that pipes a
 * command: every key is always present, and the exit code says what kind of
 * outcome it was without reading the body.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { capture, envelopeOf, json, record } from './__fixtures__/capture.js';
import { NotReady } from './__fixtures__/failures.js';
import { defineCli } from './cli.js';
import { defineCommand } from './command.js';

const program = defineCli({
  name: 'tool',
  version: '2.0.0',
  docsUrl: 'https://example.test/errors',
  commands: {
    seed: defineCommand({
      describe: 'seed',
      input: z.object({ batches: z.int().min(1).default(1) }),
      run: ({ input }) => (input.batches === 9 ? NotReady({ provider: 'local' }) : { embedded: input.batches * 100 }),
    }),
    crash: defineCommand({
      describe: 'throws',
      run: () => {
        throw new Error('database password is hunter2 at line 3');
      },
    }),
  },
});

const KEYS = ['ok', 'command', 'data', 'error', 'meta'];
const ERROR_KEYS = ['code', 'message', 'remediation', 'issues', 'data', 'retryable', 'outcome', 'exitCode', 'docsUrl'];

describe('envelope arki.cli/1', () => {
  it('ok: data, error null, exit 0', async () => {
    const { exitCode, stdout } = await capture(program, ['seed', '--batches', '2']);
    expect(exitCode).toBe(0);
    expect(Object.keys(json(stdout))).toEqual(KEYS);
    expect(envelopeOf(stdout)).toMatchSnapshot();
  });

  it('invalid input: issues name the flag, outcome unchanged, exit 2', async () => {
    const { exitCode, stdout } = await capture(program, ['seed', '--batches', 'big']);
    expect(exitCode).toBe(2);
    const envelope = envelopeOf(stdout);
    expect(envelope).toMatchSnapshot();
    expect(Object.keys(record(json(stdout)['error']))).toEqual(ERROR_KEYS);
  });

  it('a schema rule (min 1) is an issue on the flag too, not a parser error', async () => {
    const { exitCode, stdout } = await capture(program, ['seed', '--batches', '0']);
    expect(exitCode).toBe(2);
    expect(json(stdout)['error']).toMatchObject({ issues: [{ path: ['batches'], flag: '--batches' }] });
  });

  it('a failure run returns with status 503: retryable, outcome unknown, exit 4', async () => {
    const { exitCode, stdout } = await capture(program, ['seed', '--batches', '9']);
    expect(exitCode).toBe(4);
    expect(envelopeOf(stdout)).toMatchSnapshot();
  });

  it('a thrown error is cli.bug, exit 1, message only: no stack in the envelope', async () => {
    const { exitCode, stdout } = await capture(program, ['crash']);
    expect(exitCode).toBe(1);
    expect(envelopeOf(stdout)).toMatchSnapshot();
    expect(stdout).not.toContain('envelope.test.ts');
  });

  it('an unknown command is exit 2 with suggestions', async () => {
    const { exitCode, stdout } = await capture(program, ['sed']);
    expect(exitCode).toBe(2);
    expect(json(stdout)['error']).toMatchObject({
      code: 'cli.unknown_command',
      data: { received: 'sed', suggestions: ['seed'] },
      docsUrl: 'https://example.test/errors#cli-unknown-command',
    });
  });
});
