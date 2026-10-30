/**
 * The framework failures an app command may return: each keeps its exact code,
 * its data, and the exit code the process ends with.
 */
import { describe, expect, it } from 'vitest';

import { capture, json } from './__fixtures__/capture.js';
import { defineCli } from './cli.js';
import { defineCommand } from './command.js';
import { ConfirmationRequired, InputRequired } from './failures.js';

const program = defineCli({
  name: 'app',
  version: '1.0.0',
  commands: {
    ask: defineCommand({ describe: 'Needs a name', run: () => InputRequired({ field: 'name', flag: '--name' }) }),
    wipe: defineCommand({ describe: 'Needs --yes', run: () => ConfirmationRequired({ flag: '--yes' }) }),
  },
});

describe('InputRequired and ConfirmationRequired', () => {
  it('a missing input is cli.input_required with the flag to pass, exit 5', async () => {
    const { exitCode, stdout } = await capture(program, ['ask']);
    expect(exitCode).toBe(5);
    expect(json(stdout)['error']).toMatchObject({ code: 'cli.input_required', data: { field: 'name', flag: '--name' } });
  });

  it('a command that needs confirmation is cli.confirmation_required, exit 5', async () => {
    const { exitCode, stdout } = await capture(program, ['wipe']);
    expect(exitCode).toBe(5);
    expect(json(stdout)['error']).toMatchObject({ code: 'cli.confirmation_required', data: { flag: '--yes' } });
  });
});
