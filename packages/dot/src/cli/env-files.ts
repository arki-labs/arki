/** Shared plumbing for the `dot env` commands: which file, which root, what git tracks. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { EnvDescription } from '@arki/env/core';
import { describeEnv } from '@arki/env/core';
import { findRoot } from '@arki/env/node';
import { is } from '@arki/schema';

/** The flags every `dot env` command shares. */
export const envTargetInput = {
  env: z.string().regex(/^[a-z][\w-]*$/).optional().describe('Environment: picks .env.<env> (default: NODE_ENV, else development)'),
  file: z.string().optional().describe('Env file to edit (default: .env.<env> in the working directory)'),
  cwd: z.string().optional().describe('Working directory (default: current)'),
};

/** The resolved target of a command. */
export type EnvTarget = { readonly cwd: string; readonly root: string; readonly environment: string; readonly file: string };

/** Resolve the flags into absolute paths and an environment name. */
export function resolveTarget(input: { readonly env?: string | undefined; readonly file?: string | undefined; readonly cwd?: string | undefined }): EnvTarget {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const environment = input.env ?? nonEmpty(process.env['NODE_ENV']) ?? 'development';
  const file = input.file === undefined ? path.join(cwd, `.env.${environment}`) : path.resolve(cwd, input.file);
  return { cwd, root: findRoot(cwd), environment, file };
}

/** `file` relative to `root`, for messages and JSON. */
export function relative(root: string, file: string): string {
  return path.relative(root, file) || '.';
}

/**
 * What git says about the repository: a list, or why it could not answer. Outside a git repository
 * nothing is tracked (an empty list); inside one, a failing git is `unknown`, never "nothing tracked",
 * so a check that depends on it fails closed.
 */
export type GitAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function git(root: string, args: readonly string[]): GitAnswer<readonly string[]> {
  if (!existsSync(path.join(root, '.git'))) return { ok: true, value: [] };
  try {
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, value: out.split('\0').filter(Boolean) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.split('\n')[0] ?? 'git failed' : 'git failed' };
  }
}

/** The files among `files` that git tracks. Files outside `root` are never tracked. */
export function trackedFiles(root: string, files: readonly string[]): GitAnswer<ReadonlySet<string>> {
  const inside = files.filter(file => !path.relative(root, file).startsWith('..'));
  if (inside.length === 0) return { ok: true, value: new Set() };
  const answer = git(root, ['ls-files', '-z', '--', ...inside.map(file => path.relative(root, file))]);
  return answer.ok ? { ok: true, value: new Set(answer.value.map(file => path.join(root, file))) } : answer;
}

/** Every file in the repository (tracked or not ignored) whose name is `name`. */
export function filesNamed(root: string, name: string): GitAnswer<readonly string[]> {
  const answer = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return answer.ok ? { ok: true, value: [...new Set(answer.value.filter(file => path.basename(file) === name))].map(file => path.join(root, file)) } : answer;
}

/** Tracked files whose name starts with `.env.keys`: each is a leaked private key. */
export function trackedKeyFiles(root: string): GitAnswer<readonly string[]> {
  const answer = git(root, ['ls-files', '-z']);
  return answer.ok ? { ok: true, value: answer.value.filter(file => path.basename(file).startsWith('.env.keys')) } : answer;
}

/** The app's env schema, or why it could not be read (`problem`). No module at all is not a problem. */
export type SchemaAnswer = { readonly description: EnvDescription | undefined; readonly problem?: string };

/**
 * The env schema of the app in `cwd`, merged across every `defineEnv` export of its env module
 * (`--schema`, else `src/env.ts`, else `env.ts`). A module that fails to import (Node without
 * TypeScript support, a broken import) is reported in `problem`, never thrown and never silent.
 */
export async function loadDescription(cwd: string, schema?: string): Promise<SchemaAnswer> {
  const candidates = schema === undefined ? ['src/env.ts', 'env.ts'].map(file => path.join(cwd, file)) : [path.resolve(cwd, schema)];
  const module = candidates.find(file => existsSync(file));
  if (module === undefined) return { description: undefined };
  // Only the declaration is read, never a value, and the files are not loaded yet. An env built by
  // `defineEnv` validates the first time anything touches it (even listing its keys), so the switch
  // stays on until the scan is done.
  const skip = process.env.SKIP_ENV_VALIDATION;
  process.env.SKIP_ENV_VALIDATION = '1';
  try {
    let loaded: unknown;
    try {
      loaded = await import(pathToFileURL(module).href);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'import failed';
      return { description: undefined, problem: `cannot import ${path.relative(cwd, module)} (${reason}); run \`dot\` under Bun (\`bun --bun dot env ...\`) to read secret() keys` };
    }
    if (!is(loaded, z.record(z.string(), z.unknown()))) return { description: undefined };
    const keys = new Map<string, EnvDescription['keys'][number]>();
    // `is` narrows the export itself: the description is keyed by the env object, and a parsed copy would miss it.
    for (const value of Object.values(loaded)) {
      if (!is(value, z.object({}).loose())) continue;
      for (const key of describeEnv(value)?.keys ?? []) keys.set(key.key, key);
    }
    return { description: keys.size === 0 ? undefined : { keys: [...keys.values()] } };
  } finally {
    if (skip === undefined) delete process.env.SKIP_ENV_VALIDATION;
    else process.env.SKIP_ENV_VALIDATION = skip;
  }
}

/** The shape of a value, safe to print: `hex`, `base64`, `url`, `number`, `text`. */
export function charClass(value: string): string {
  if (/^\d+$/.test(value)) return 'number';
  if (/^[\da-f]+$/i.test(value)) return 'hex';
  if (/^[a-z][\d+.a-z-]*:\/\//i.test(value)) return 'url';
  if (/^[\w+/=-]+$/.test(value)) return 'base64';
  return 'text';
}

/** All of stdin as text, with one trailing newline removed. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
