/** Shared plumbing for the `dot env` commands: which file, which root, what git tracks. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { EnvDescription } from '@arki/env/core';
import { describeEnv } from '@arki/env/core';
import { findRoot } from '@arki/env/node';

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

/** The files among `files` that git tracks. Empty outside a git repository. */
export function trackedFiles(root: string, files: readonly string[]): ReadonlySet<string> {
  if (files.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...files.map(file => path.relative(root, file))], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(out.split('\0').filter(Boolean).map(file => path.join(root, file)));
  } catch {
    return new Set();
  }
}

/** Every file in the repository (tracked or not ignored) whose name is `name`. */
export function filesNamed(root: string, name: string): readonly string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return [...new Set(out.split('\0').filter(file => path.basename(file) === name))].map(file => path.join(root, file));
  } catch {
    return [];
  }
}

/** Tracked files whose name starts with `.env.keys`: each is a leaked private key. */
export function trackedKeyFiles(root: string): readonly string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(file => path.basename(file).startsWith('.env.keys'));
  } catch {
    return [];
  }
}

/**
 * The env schema of the app in `cwd`, merged across every `defineEnv` export of its env module
 * (`--schema`, else `src/env.ts`, else `env.ts`). `undefined` when there is none or it fails to load.
 */
export async function loadDescription(cwd: string, schema: string | undefined): Promise<EnvDescription | undefined> {
  const candidates = schema === undefined ? ['src/env.ts', 'env.ts'].map(file => path.join(cwd, file)) : [path.resolve(cwd, schema)];
  const module = candidates.find(file => existsSync(file));
  if (module === undefined) return undefined;
  const loaded: unknown = await import(pathToFileURL(module).href);
  const exports = z.record(z.string(), z.unknown()).safeParse(loaded);
  if (!exports.success) return undefined;
  const keys = new Map<string, EnvDescription['keys'][number]>();
  for (const value of Object.values(exports.data)) {
    const object = z.object({}).loose().safeParse(value);
    const description = object.success ? describeEnv(object.data) : undefined;
    for (const key of description?.keys ?? []) keys.set(key.key, key);
  }
  return keys.size === 0 ? undefined : { keys: [...keys.values()] };
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
