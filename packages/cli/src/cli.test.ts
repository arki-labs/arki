/**
 * `main` end to end: services are resolved only for a real run (help must
 * work with the database down), input comes from flags or JSON but not both,
 * `--dry-run` never runs `run`, and an interrupt is reported as one.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import { capture, json } from './__fixtures__/capture.js';
import { fixtureCli } from './__fixtures__/tree.js';
import { defineCli } from './cli.js';
import { defineCommand } from './command.js';

/** Stdin in two chunks, a string and bytes, the way a pipe may deliver it. */
async function* chunks(): AsyncGenerator<string | Uint8Array> {
  yield await Promise.resolve('{"maxBatches":');
  yield new TextEncoder().encode('2}');
}

function noop(describe: string, aliases?: readonly string[]) {
  return defineCommand({ describe, ...(aliases === undefined ? {} : { aliases }), run: () => 0 });
}

describe('services', () => {
  it('are not resolved for --help, --version or a parse failure', async () => {
    const services = vi.fn(() => ({}));
    const program = fixtureCli(services);
    await capture(program, ['--help']);
    await capture(program, ['seed', '--help']);
    await capture(program, ['--version']);
    const notAnInteger = await capture(program, ['seed', '--max-batches', 'x']);
    const belowMinimum = await capture(program, ['seed', '0']);
    expect([notAnInteger.exitCode, belowMinimum.exitCode]).toEqual([2, 2]);
    expect(services).not.toHaveBeenCalled();
  });

  it('are resolved once for a run and reach ctx.services', async () => {
    let calls = 0;
    const program = defineCli({
      name: 'tool',
      version: '1.0.0',
      services: () => {
        calls += 1;
        return { greeting: 'hello' };
      },
      commands: {
        greet: defineCommand({
          describe: 'greet',
          run: ctx => {
            expectTypeOf(ctx.services).toEqualTypeOf<unknown>();
            return ctx.services;
          },
        }),
      },
    });
    const { exitCode, stdout } = await capture(program, ['greet']);
    expect(exitCode).toBe(0);
    expect(json(stdout)['data']).toEqual({ greeting: 'hello' });
    expect(calls).toBe(1);
  });
});

describe('input', () => {
  const program = fixtureCli();

  it('takes the whole input from --input-json', async () => {
    const { exitCode, stdout } = await capture(program, ['seed', '--input-json', '{"maxBatches":3}']);
    expect(exitCode).toBe(0);
    expect(json(stdout)['data']).toEqual({ embedded: 300 });
  });

  it('reads --input-file - from stdin', async () => {
    const { stdout } = await capture(program, ['seed', '--input-file', '-'], { stdin: chunks() });
    expect(json(stdout)['data']).toEqual({ embedded: 200 });
  });

  it('fails --input-json mixed with flags: two sources of the same input would silently disagree', async () => {
    const { exitCode, stdout } = await capture(program, ['seed', '--yes', '--input-json', '{}']);
    expect(exitCode).toBe(2);
    expect(json(stdout)['error']).toMatchObject({ code: 'cli.invalid_input', issues: [{ flag: '--input-json' }] });
  });

  it('fails an -o that is not a mode', async () => {
    const { exitCode, stdout } = await capture(program, ['seed', '-o', 'yaml']);
    expect(exitCode).toBe(2);
    expect(json(stdout)['error']).toMatchObject({ issues: [{ flag: '--output' }] });
  });
});

describe('--dry-run', () => {
  const program = fixtureCli();

  it('runs preview instead of run and says so in meta', async () => {
    const { exitCode, stdout } = await capture(program, ['seed', '5', '--dry-run']);
    expect(exitCode).toBe(0);
    expect(json(stdout)).toMatchObject({ data: { embedded: 0 }, meta: { dryRun: true } });
  });

  it('fails with exit 2 on a command without preview, so a dry run never changes anything', async () => {
    const { exitCode, stdout } = await capture(program, ['ping', 'now', '--dry-run']);
    expect(exitCode).toBe(2);
    expect(json(stdout)['error']).toMatchObject({ code: 'cli.preview_unsupported', outcome: 'unchanged' });
  });
});

describe('text mode', () => {
  const program = fixtureCli();

  it('renders on stdout on a terminal', async () => {
    const { exitCode, stdout } = await capture(program, ['ping', 'now'], { tty: true });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('name   ok\ndb     true\nqueue  false\n');
  });

  it('writes a failure to stderr with its remediation, keeping stdout clean', async () => {
    const { exitCode, stdout, stderr } = await capture(program, ['seed', '99'], { tty: true });
    expect(exitCode).toBe(4);
    expect(stdout).toBe('');
    expect(stderr).toBe('fixture: embed.not_ready provider local is not ready\nStart the provider, then retry.\n');
  });

  it('--fields applies in text mode too', async () => {
    const { stdout } = await capture(program, ['seed', '2', '--fields', 'embedded', '-o', 'text']);
    expect(stdout).toBe('embedded: 200\n');
  });
});

describe('signals', () => {
  it('a run that ends after the abort is cli.cancelled, exit 130', async () => {
    const controller = new AbortController();
    const program = defineCli({
      name: 'tool',
      version: '1.0.0',
      commands: {
        wait: defineCommand({
          describe: 'waits for the abort',
          run: ({ signal }) =>
            new Promise<string>((_, reject) => {
              signal.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
              controller.abort();
            }),
        }),
      },
    });
    const { exitCode, stdout } = await capture(program, ['wait'], { signal: controller.signal });
    expect(exitCode).toBe(130);
    expect(json(stdout)['error']).toMatchObject({ code: 'cli.cancelled', outcome: 'unknown' });
  });
});

describe('defineCli checks the definition once', () => {
  it('rejects an alias that is already a name at its level', () => {
    expect(() =>
      defineCli({ name: 't', version: '1', commands: { list: noop('list'), show: noop('show', ['list']) } }),
    ).toThrow(/"list" is already a command or alias/);
  });

  it('rejects an input key that collides with a global flag, naming it', () => {
    const bad = defineCommand({ describe: 'bad', input: z.object({ quiet: z.boolean() }), run: () => 0 });
    expect(() => defineCli({ name: 't', version: '1', commands: { bad } })).toThrow(/"quiet" collides/);
  });
});
