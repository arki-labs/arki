/**
 * `dot env check`: the gate for CI and pre-commit. Fails on anything that leaks or breaks a boot:
 * unloadable files, refused keys, plaintext `secret()` keys in tracked files, tracked `.env.keys`.
 * Warns on shadowed values and on legacy bare `.env` files. Calls no secret manager unless `--resolve`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { DEFAULT_RESOLVERS, envDirs, loadEnvFiles } from '@arki/env/node';

import { envTargetInput, loadDescription, relative, resolveTarget, trackedFiles, trackedKeyFiles } from '../../env-files.js';
import type { EnvFinding } from '../../env-failures.js';
import { EnvCheckFailed } from '../../env-failures.js';

/** Resolvers that return a placeholder, so `check` stays offline unless `--resolve`. */
const OFFLINE_RESOLVERS = Object.fromEntries(Object.keys(DEFAULT_RESOLVERS).map(scheme => [scheme, () => '']));

export default defineCommand({
  describe: 'Check the env files: loadable, no plaintext secrets tracked, no keys tracked',
  input: z.object({
    resolve: z.boolean().default(false).describe('Also resolve op://, infisical:// and doppler:// references'),
    schema: z.string().optional().describe('Env module to read secret() keys from (default: src/env.ts)'),
    env: envTargetInput.env,
    cwd: envTargetInput.cwd,
  }),
  effects: 'read',
  examples: ['dot env check', 'dot env check --env production --json | jq .data.findings'],
  async run({ input }) {
    const target = resolveTarget(input);
    const report = loadEnvFiles({
      cwd: target.cwd,
      root: target.root,
      environment: target.environment,
      env: { ...process.env },
      write: false,
      references: input.resolve ? DEFAULT_RESOLVERS : OFFLINE_RESOLVERS,
    });
    const schema = await loadDescription(target.cwd, input.schema);
    const secretKeys = new Set((schema.description?.keys ?? []).filter(key => key.secret).map(key => key.key));
    const tracked = trackedFiles(target.root, report.files);
    const keyFiles = trackedKeyFiles(target.root);
    const gitFailures = [tracked, keyFiles].flatMap(answer => (answer.ok ? [] : [answer.reason]));
    const findings: EnvFinding[] = [
      ...report.errors.map(error => ({
        code: error.code,
        severity: 'error' as const,
        message: error.message,
        remediation: 'See the error code in the @arki/env docs; most often the private key is missing.',
        file: relative(target.root, error.file),
        ...(error.key === undefined ? {} : { key: error.key }),
      })),
      ...report.refused.map(entry => ({
        code: 'dot.env.refused_key',
        severity: 'error' as const,
        message: `${entry.key} is never loaded from a file: ${entry.reason}`,
        remediation: 'Remove it from the file; set it in the shell or the deploy platform if a machine needs it.',
        file: relative(target.root, entry.file),
        key: entry.key,
      })),
      ...(schema.problem === undefined
        ? []
        : [
            {
              code: 'dot.env.schema_unavailable',
              severity: 'warning' as const,
              message: `secret() keys not checked: ${schema.problem}`,
              remediation: 'Run the check under Bun: `bun --bun dot env check`.',
            },
          ]),
      ...[...new Set(gitFailures)].map(reason => ({
        code: 'dot.env.git_unavailable',
        severity: 'error' as const,
        message: `cannot ask git which files are tracked: ${reason}`,
        remediation: 'Fix git in this repository (`git status` must work), then run the check again.',
      })),
      ...(keyFiles.ok ? keyFiles.value : []).map(file => ({
        code: 'dot.env.tracked_keys',
        severity: 'error' as const,
        message: `${file} is tracked by git: its private keys are exposed`,
        remediation: `git rm --cached ${file}, add .env.keys* to .gitignore, then rotate: dot env rotate --env <env>.`,
        file,
      })),
      ...report.values
        .filter(value => value.kind === 'plain' && secretKeys.has(value.key) && tracked.ok && tracked.value.has(value.file))
        .map(value => ({
          code: 'dot.env.plaintext_secret',
          severity: 'error' as const,
          message: `${value.key} is declared secret() but is plaintext in a tracked file`,
          remediation: `dot env encrypt --key ${value.key} --file ${relative(target.root, value.file)}`,
          file: relative(target.root, value.file),
          key: value.key,
        })),
      ...report.shadowed.map(entry => ({
        code: 'dot.env.shadowed',
        severity: 'warning' as const,
        message: `${entry.key} in ${relative(target.root, entry.file)}:${String(entry.line)} is overridden by a different value in the environment`,
        remediation: `Unset ${entry.key} in the shell if the file should win (\`dot env explain ${entry.key}\`).`,
        file: relative(target.root, entry.file),
        key: entry.key,
      })),
      ...envDirs(target.root, target.cwd)
        .map(dir => path.join(dir, '.env'))
        .filter(file => existsSync(file))
        .map(file => ({
          code: 'dot.env.legacy_file',
          severity: 'warning' as const,
          message: `${relative(target.root, file)} is a bare .env file: dot env does not load it`,
          remediation: `Move its values: dot env encrypt --from ${relative(target.cwd, file)}, then delete it once the private key is backed up.`,
          file: relative(target.root, file),
        })),
    ];
    if (findings.some(finding => finding.severity === 'error')) return EnvCheckFailed({ findings });
    return { ok: true, environment: target.environment, files: report.files.map(file => relative(target.root, file)), findings };
  },
  render(data, ui) {
    ui.out(`${data.environment}: ${String(data.files.length)} file(s) ok`);
    for (const finding of data.findings) ui.warn(`${finding.code}: ${finding.message}`);
  },
});
