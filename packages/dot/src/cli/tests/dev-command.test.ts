/**
 * The `dot dev` flags are the user's safety switches (`--allow-remote-db`,
 * `--db`, `--no-open`): they must reach the supervisor exactly as typed, with
 * the documented defaults, and a typo must fail instead of being ignored.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RunDevOptions } from '../dev.js';
import { program } from '../index.js';

const received: RunDevOptions[] = [];

vi.mock('../dev.js', () => ({
  runDev: (options: RunDevOptions) => {
    received.push(options);
    return Promise.resolve({ items: [] });
  },
}));

async function main(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  let stdout = '';
  const code = await program.main(argv, {
    stdout: text => {
      stdout += text;
    },
  });
  return { code, stdout };
}

describe('dot dev flags', () => {
  it('fills the defaults', async () => {
    received.length = 0;
    const { code } = await main(['dev', '--json']);
    expect(code).toBe(0);
    expect(received[0]).toEqual(
      expect.objectContaining({
        db: 'auto',
        allowRemoteDb: false,
        port: 3000,
        consolePort: 4321,
        console: true,
        open: true,
        once: false,
        mode: 'json',
      }),
    );
  });

  it('parses every flag, --no-open and --no-console included', async () => {
    received.length = 0;
    const { code } = await main([
      'dev',
      '--db',
      'pg',
      '--allow-remote-db',
      '--port',
      '4000',
      '--console-port',
      '4400',
      '--no-console',
      '--no-open',
      '--once',
      '--run',
      'bun run serve.ts',
      '--app',
      'src/app.ts',
      '--json',
    ]);
    expect(code).toBe(0);
    expect(received[0]).toEqual(
      expect.objectContaining({
        db: 'pg',
        allowRemoteDb: true,
        port: 4000,
        consolePort: 4400,
        console: false,
        open: false,
        once: true,
        run: 'bun run serve.ts',
        app: 'src/app.ts',
      }),
    );
  });

  it('rejects an unknown flag and a bad --db before running', async () => {
    received.length = 0;
    const unknown = await main(['dev', '--allow-remote', '--json']);
    const badDb = await main(['dev', '--db', 'mysql', '--json']);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.stdout)).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: 'cli.invalid_input' }) }),
    );
    expect(badDb.code).toBe(2);
    expect(received).toEqual([]);
  });

  it('prints one event per line with --output ndjson', async () => {
    const { code, stdout } = await main(['dev', '-o', 'ndjson']);
    expect(code).toBe(0);
    // The mock returns no events: only the closing envelope line.
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });
});
