/**
 * `dot env run -- <cmd>`: start a command with the env files loaded into its environment. The
 * child's output is the command's whole output (no envelope). When stdout is not a terminal (an
 * agent, a pipe, CI), secret values in the child's stdout and stderr are replaced by `[redacted]`.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { findPrivateKey, isKeyName, loadEnvFiles } from '@arki/env/node';
import { isFailure } from '@arki/failure';
import { MIN_SECRET_LENGTH } from '@arki/log';

import { EnvCommandFailed } from '../../env-failures.js';
import { envTargetInput, loadDescription, relative, resolveTarget } from '../../env-files.js';
import { createRedactor } from '../../env-redact.js';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export default defineCommand({
  describe: 'Run a command with the env files loaded; redacts secrets when output is not a terminal',
  input: z.object({
    command: z.array(z.string()).min(1).describe('The command and its arguments, after --'),
    redact: z
      .boolean()
      .optional()
      .describe('Replace secret values in the output (default: on unless stdout is a terminal)'),
    env: envTargetInput.env,
    cwd: envTargetInput.cwd,
  }),
  args: ['command'],
  passthrough: true,
  effects: 'write',
  examples: [
    'dot env run -- bun run dev',
    'dot env run -- drizzle-kit push',
    'dot env run --no-redact -- printenv DB_URL',
  ],
  async run({ input, ui }) {
    const target = resolveTarget(input);
    const env: Record<string, string | undefined> = { ...process.env };
    const report = loadEnvFiles({ cwd: target.cwd, root: target.root, environment: target.environment, env });
    if (isFailure(report)) return report;
    for (const entry of report.shadowed)
      ui.warn(`${entry.key}: the environment overrides ${relative(target.root, entry.file)}:${String(entry.line)}`);
    for (const entry of report.refused)
      ui.warn(`${entry.key} in ${relative(target.root, entry.file)} not loaded: ${entry.reason}`);

    // The child never gets a private key: with it, `dot env run -- <agent>` would hand over every secret.
    const privateKeys: string[] = [];
    for (const key of Object.keys(env)) {
      if (!isKeyName(key) || !key.startsWith('DOTENV_PRIVATE_KEY')) continue;
      privateKeys.push(...(env[key] ?? '').split(','));
      delete env[key];
    }
    for (const value of report.values) {
      if (value.kind === 'encrypted') {
        const found = findPrivateKey(value.file, { root: target.root, env: process.env });
        if (isFailure(found)) return found;
        privateKeys.push(...(found?.keys ?? []));
      }
    }

    const redact = input.redact ?? process.stdout.isTTY !== true;
    const declaredSecret = await secretKeysOf(target.cwd);
    // Redact what the child actually gets: the file value and, when the environment wins or no key
    // was needed, the inherited value too.
    const secrets = [
      ...privateKeys,
      ...report.values.flatMap(value =>
        value.kind === 'plain' && !declaredSecret.has(value.key) ? [] : [value.value ?? '', env[value.key] ?? ''],
      ),
    ].filter(secret => secret !== '');
    if (redact) {
      for (const value of report.values) {
        if (value.value !== undefined && value.kind !== 'plain' && value.value.length < MIN_SECRET_LENGTH) {
          ui.warn(`${value.key} is shorter than ${String(MIN_SECRET_LENGTH)} characters and is not redacted`);
        }
      }
    }
    const [command = '', ...args] = input.command;
    const child = spawn(command, args, {
      cwd: target.cwd,
      env,
      stdio: redact ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });
    if (redact) {
      const out = createRedactor(secrets, text => process.stdout.write(text));
      const err = createRedactor(secrets, text => process.stderr.write(text));
      child.stdout?.on('data', (chunk: Buffer) => out.write(chunk));
      child.stdout?.on('end', () => out.end());
      child.stderr?.on('data', (chunk: Buffer) => err.write(chunk));
      child.stderr?.on('end', () => err.end());
    }
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of SIGNALS) process.on(signal, forward);
    try {
      return await new Promise<number | ReturnType<typeof EnvCommandFailed>>(resolve => {
        child.once('error', error => resolve(EnvCommandFailed({ command, reason: error.message })));
        child.once('close', (code, signal) => resolve(code ?? (signal === null ? 1 : 128 + signalNumber(signal))));
      });
    } finally {
      for (const signal of SIGNALS) process.off(signal, forward);
    }
  },
});

/** Keys the app schema declares `secret()`. A schema that cannot load only costs this extra redaction (files' encrypted values are still redacted). */
async function secretKeysOf(cwd: string): Promise<ReadonlySet<string>> {
  const schema = await loadDescription(cwd);
  return new Set((schema.description?.keys ?? []).filter(key => key.secret).map(key => key.key));
}

function signalNumber(signal: NodeJS.Signals): number {
  return { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }[signal as string] ?? 1;
}
