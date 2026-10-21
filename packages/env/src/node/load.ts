/**
 * `loadEnvFiles()`: read the env files from the repository root down to the working directory,
 * decrypt and resolve their values, and write the ones the real environment does not set into it.
 *
 * Values go into `process.env` on purpose: package envs (`@arki/db/env` and others) read it, some
 * of them while their module loads, so the files must be loaded before the app's modules are. Run
 * `dot env run -- <cmd>` or import `@arki/env/node/register` first in the entry file.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { decryptValue, envValues, isEncrypted, isKeyName, keyNamesFor, parseEnv } from './codec.js';
import { findPrivateKey, keysFileCandidates } from './keys.js';
import type { ReferenceResolver } from './references.js';
import { DEFAULT_RESOLVERS, referenceScheme } from './references.js';

export const ENV_FILES_ERROR_CODES = {
  /**
   * An env file holds encrypted values and no private key for it was found.
   *
   * @fix Export the `DOTENV_PRIVATE_KEY_<ENV>` named in the message, or run `dot env keys pull`, or restore `.env.keys`.
   * @verify dot env check --json | jq -e .ok
   */
  missingPrivateKey: 'ARKI_ENV_FILES_E001',
  /**
   * A value could not be decrypted: the private key is not the one the file was encrypted to, or the value is damaged.
   *
   * @fix Run `dot env explain <KEY>` to see which key was used; re-set the value with `dot env set <KEY> --stdin`.
   * @verify dot env check --json | jq -e .ok
   */
  cannotDecrypt: 'ARKI_ENV_FILES_E002',
  /**
   * A `scheme://` reference could not be resolved by its provider CLI.
   *
   * @fix Install the provider CLI named in the message, log in, and check the reference path.
   * @verify dot env check --resolve --json | jq -e .ok
   */
  unresolvedReference: 'ARKI_ENV_FILES_E003',
} as const;

/** How `loadEnvFiles` finds, reads and applies the files. */
export type LoadEnvFilesOptions = {
  /** Where to stop descending. Default: `process.cwd()`. */
  readonly cwd?: string;
  /** Where to start. Default: the nearest ancestor with `.git`, else with a `workspaces` package.json, else `cwd`. */
  readonly root?: string;
  /** Picks `.env.<environment>`. Default: `NODE_ENV`, else `development`. */
  readonly environment?: string;
  /** File names read in every directory, later wins. Default: `.env.<environment>`, then `.env.local` (not under `test`). */
  readonly files?: readonly string[];
  /** The environment read and written. Default: `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** `false` reads and decrypts without writing anything. Default: `true`. */
  readonly write?: boolean;
  /** Reference resolvers by scheme. Default: `op`, `infisical`, `doppler`. */
  readonly references?: Readonly<Record<string, ReferenceResolver>>;
};

/** How a value is stored in its file. */
export type EnvValueKind = 'plain' | 'encrypted' | 'reference';

/** The winning file entry of one key. `value` is the plaintext, absent when it could not be read. */
export type EnvFileValue = {
  readonly key: string;
  readonly file: string;
  readonly line: number;
  readonly kind: EnvValueKind;
  readonly value?: string;
};

/** One problem, by name. Messages never contain a value. */
export type EnvFilesError = {
  readonly code: (typeof ENV_FILES_ERROR_CODES)[keyof typeof ENV_FILES_ERROR_CODES];
  readonly message: string;
  readonly file: string;
  readonly key?: string;
};

/** What a load found and did. Holds plaintext in `values`: never print it whole. */
export type EnvFilesReport = {
  readonly root: string;
  readonly environment: string;
  /** Files read, in load order. */
  readonly files: readonly string[];
  readonly values: readonly EnvFileValue[];
  /** Keys written into the environment. */
  readonly applied: readonly string[];
  /** Keys the real environment set to a different value, so the file value was not used. */
  readonly shadowed: readonly { readonly key: string; readonly file: string; readonly line: number }[];
  /** File entries never applied: loader-hijacking keys (`NODE_OPTIONS`, `LD_*`, `DYLD_*`) and references into public keys. */
  readonly refused: readonly { readonly key: string; readonly file: string; readonly line: number; readonly reason: string }[];
  readonly errors: readonly EnvFilesError[];
};

const loadedSecrets = new Set<string>();

/**
 * Keys a file may never set: they make a process started with this environment load other code
 * (interpreter options, preload and module paths, shell startup files) or trust another TLS
 * authority. A machine that needs one sets it in its own shell.
 */
const REFUSED_KEY =
  /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BUN_OPTIONS|LD_\w+|DYLD_\w+|BASH_ENV|ENV|PERL5OPT|PERL5LIB|PYTHONPATH|PYTHONSTARTUP|RUBYOPT)$/i;

/** Keys bundlers inline into browser code. */
const PUBLIC_KEY = /^(?:VITE_|NEXT_PUBLIC_|PUBLIC_|EXPO_PUBLIC_)/;

/** Load the env files. Never throws for bad files: problems are in `report.errors`. */
export function loadEnvFiles(options: LoadEnvFilesOptions = {}): EnvFilesReport {
  const target = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const root = path.resolve(options.root ?? findRoot(cwd));
  const environment = options.environment ?? nonEmpty(target['NODE_ENV']) ?? 'development';
  const names = options.files ?? [`.env.${environment}`, ...(environment === 'test' ? [] : ['.env.local'])];
  const resolvers = options.references ?? DEFAULT_RESOLVERS;

  const files = envDirs(root, cwd)
    .flatMap(dir => names.map(name => path.join(dir, name)))
    .filter(file => existsSync(file));

  const winners = new Map<string, { readonly file: string; readonly line: number; readonly raw: string }>();
  const refused: { key: string; file: string; line: number; reason: string }[] = [];
  for (const file of files) {
    for (const [key, entry] of envValues(parseEnv(readFileSync(file, 'utf8')))) {
      if (isKeyName(key)) continue;
      if (REFUSED_KEY.test(key)) {
        refused.push({ key, file, line: entry.start + 1, reason: 'changes how every child process loads code' });
        continue;
      }
      winners.set(key, { file, line: entry.start + 1, raw: entry.value });
    }
  }

  const errors: EnvFilesError[] = [];
  const keysByFile = new Map<string, readonly string[] | null>();
  const privateKeysFor = (file: string): readonly string[] | null => {
    if (!keysByFile.has(file)) {
      const found = findPrivateKey(file, { root, env: target });
      keysByFile.set(file, found?.keys ?? null);
      if (found === undefined) {
        errors.push({
          code: ENV_FILES_ERROR_CODES.missingPrivateKey,
          file,
          message: `${path.relative(root, file)} has encrypted values but no private key: set ${privateKeyHint(file)} or add it to ${keysFileCandidates(file, root)
            .map(candidate => path.relative(root, candidate))
            .join(' or ')}`,
        });
      }
    }
    return keysByFile.get(file) ?? null;
  };

  const values: EnvFileValue[] = [];
  for (const [key, { file, line, raw }] of winners) {
    if (isEncrypted(raw)) {
      const keys = privateKeysFor(file);
      if (keys === null) {
        values.push({ key, file, line, kind: 'encrypted' });
        continue;
      }
      const value = tryDecrypt(raw, keys);
      if (value === undefined) {
        errors.push({ code: ENV_FILES_ERROR_CODES.cannotDecrypt, file, key, message: `${key} in ${path.relative(root, file)}:${String(line)} cannot be decrypted with ${privateKeyHint(file)}` });
        values.push({ key, file, line, kind: 'encrypted' });
      } else {
        values.push({ key, file, line, kind: 'encrypted', value });
      }
      continue;
    }
    const scheme = referenceScheme(raw, resolvers);
    if (scheme === undefined) {
      values.push({ key, file, line, kind: 'plain', value: raw });
      continue;
    }
    if (PUBLIC_KEY.test(key)) {
      refused.push({ key, file, line, reason: 'a public (browser-bundled) key cannot hold a secret-manager reference' });
      continue;
    }
    try {
      values.push({ key, file, line, kind: 'reference', value: resolvers[scheme]?.(raw) ?? '' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'failed';
      errors.push({ code: ENV_FILES_ERROR_CODES.unresolvedReference, file, key, message: `${key} (${scheme}://) in ${path.relative(root, file)}:${String(line)}: ${reason}` });
      values.push({ key, file, line, kind: 'reference' });
    }
  }

  const applied: string[] = [];
  const shadowed: { key: string; file: string; line: number }[] = [];
  const fromFiles = new Set(values.map(value => value.key));
  for (const entry of values) {
    if (entry.value === undefined) continue;
    const current = nonEmpty(target[entry.key]);
    if (current !== undefined && !isEncrypted(current)) {
      if (current !== entry.value) shadowed.push({ key: entry.key, file: entry.file, line: entry.line });
      continue;
    }
    if (entry.kind !== 'plain') loadedSecrets.add(entry.value);
    if (options.write !== false) target[entry.key] = entry.value;
    applied.push(entry.key);
  }
  for (const [key, value] of Object.entries(target)) {
    if (value !== undefined && isEncrypted(value) && !fromFiles.has(key)) {
      errors.push({ code: ENV_FILES_ERROR_CODES.cannotDecrypt, file: '(environment)', key, message: `${key} holds an encrypted value that no loaded env file explains (a file auto-loaded by Bun?)` });
    }
  }

  return { root, environment, files, values, applied, shadowed, refused, errors };
}

/** Every value this process loaded from an encrypted or referenced entry: what log masking hides. */
export function secretValues(): readonly string[] {
  return [...loadedSecrets];
}

/** The report's errors as one message, one line each. */
export function formatEnvFilesErrors(report: EnvFilesReport): string {
  return [`Cannot load env files (${report.environment}):`, ...report.errors.map(error => `  ${error.code} ${error.message}`)].join('\n');
}

/** The nearest ancestor of `cwd` with `.git`, else with a `workspaces` package.json, else `cwd`. */
export function findRoot(cwd: string): string {
  let workspace: string | undefined;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (workspace === undefined && isWorkspaceRoot(path.join(dir, 'package.json'))) workspace = dir;
    if (path.dirname(dir) === dir) return workspace ?? cwd;
  }
}

/** The directories from `root` down to `cwd`, root first. Just `cwd` when it is not inside `root`. */
export function envDirs(root: string, cwd: string): readonly string[] {
  const relative = path.relative(root, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [cwd];
  const parts = relative === '' ? [] : relative.split(path.sep);
  return [root, ...parts.map((_, index) => path.join(root, ...parts.slice(0, index + 1)))];
}

const workspaceManifest = z.object({ workspaces: z.union([z.array(z.string()), z.object({ packages: z.array(z.string()) })]) });

function isWorkspaceRoot(manifest: string): boolean {
  if (!existsSync(manifest)) return false;
  try {
    return workspaceManifest.safeParse(JSON.parse(readFileSync(manifest, 'utf8'))).success;
  } catch {
    return false;
  }
}

function tryDecrypt(raw: string, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    try {
      return decryptValue(raw, key);
    } catch {
      // The next key may be the right one; a wrong or malformed key is reported once by the caller.
    }
  }
  return undefined;
}

function privateKeyHint(file: string): string {
  return keyNamesFor(path.basename(file)).privateKey;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
