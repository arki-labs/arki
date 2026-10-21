/**
 * File edits behind `dot env init | set | encrypt | decrypt | rotate`. Each write goes to a temp file
 * first and is renamed into place, so an interrupted command never leaves half a file.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  decryptValue,
  encryptValue,
  envHeader,
  envValues,
  generateKeypair,
  isEncrypted,
  isKeyName,
  keyNamesFor,
  parseEnv,
  publicKeyOf,
  readEnvValue,
  setEnvValue,
} from './codec.js';
import type { FoundPrivateKey } from './keys.js';
import { findPrivateKey, KEYS_FILE, writePrivateKey } from './keys.js';

/** The public key in a file's header, or `undefined` when it has none. */
export function publicKeyIn(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  return readEnvValue(parseEnv(readFileSync(file, 'utf8')), keyNamesFor(path.basename(file)).publicKey);
}

/** What `initEnvFile` did. */
export type InitResult = {
  readonly file: string;
  readonly publicKey: string;
  /** `false` when the file already had a header. */
  readonly headerAdded: boolean;
  /** Where a new private key was written; `undefined` when an existing key was reused. */
  readonly keysWritten?: string;
};

/**
 * Give `file` a dotenvx header, creating the file if needed. Reuses the private key of the same
 * environment when one is already reachable (so every `.env.development` in a repo shares one key);
 * otherwise generates a keypair and stores the private key in `<root>/.env.keys`.
 */
export function initEnvFile(
  file: string,
  options: { readonly root: string; readonly env?: Readonly<Record<string, string | undefined>> },
): InitResult {
  const existing = publicKeyIn(file);
  if (existing !== undefined) return { file, publicKey: existing, headerAdded: false };
  const names = keyNamesFor(path.basename(file));
  const found = findPrivateKey(file, { root: options.root, env: options.env ?? process.env });
  const reused = found?.keys[0];
  let publicKey: string;
  let keysWritten: string | undefined;
  if (reused === undefined) {
    const pair = generateKeypair();
    keysWritten = path.join(options.root, KEYS_FILE);
    writePrivateKey(keysWritten, names.privateKey, pair.privateKey, path.basename(file));
    publicKey = pair.publicKey;
  } else {
    publicKey = publicKeyOf(reused);
  }
  const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
  atomicWrite(file, `${envHeader(path.basename(file), publicKey)}\n${body}`);
  return keysWritten === undefined ? { file, publicKey, headerAdded: true } : { file, publicKey, headerAdded: true, keysWritten };
}

/**
 * Set `key` in `file`, encrypted to the file's public key unless `plain`. Returns `false` when the
 * file already held exactly this plaintext value (an encrypted value is always rewritten, because
 * the same plaintext never encrypts to the same bytes).
 */
export function setEnvFileValue(file: string, key: string, value: string, options: { readonly plain: boolean }): boolean {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let stored = value;
  if (!options.plain) {
    const publicKey = readEnvValue(parseEnv(text), keyNamesFor(path.basename(file)).publicKey);
    if (publicKey === undefined) throw new Error(`${path.basename(file)} has no public key header: run \`dot env init\` first`);
    stored = encryptValue(value, publicKey);
  }
  const next = setEnvValue(text, key, stored);
  if (next === text) return false;
  atomicWrite(file, next);
  return true;
}

/** Encrypt plaintext values in place: the listed keys, or every value. Returns the keys encrypted. */
export function encryptEnvFile(file: string, keys?: readonly string[]): readonly string[] {
  const text = readFileSync(file, 'utf8');
  const publicKey = readEnvValue(parseEnv(text), keyNamesFor(path.basename(file)).publicKey);
  if (publicKey === undefined) throw new Error(`${path.basename(file)} has no public key header: run \`dot env init\` first`);
  let next = text;
  const done: string[] = [];
  for (const [key, entry] of envValues(parseEnv(text))) {
    if (isKeyName(key) || isEncrypted(entry.value) || (keys !== undefined && !keys.includes(key))) continue;
    next = setEnvValue(next, key, encryptValue(entry.value, publicKey));
    done.push(key);
  }
  if (done.length > 0) atomicWrite(file, next);
  return done;
}

/** Decrypt values in place with `privateKeys`: the listed keys, or every value. Returns the keys decrypted. */
export function decryptEnvFile(file: string, privateKeys: readonly string[], keys?: readonly string[]): readonly string[] {
  const text = readFileSync(file, 'utf8');
  let next = text;
  const done: string[] = [];
  for (const [key, entry] of envValues(parseEnv(text))) {
    if (!isEncrypted(entry.value) || (keys !== undefined && !keys.includes(key))) continue;
    next = setEnvValue(next, key, decryptWithAny(entry.value, privateKeys, key));
    done.push(key);
  }
  if (done.length > 0) atomicWrite(file, next);
  return done;
}

/** What `rotateEnvFiles` did. */
export type RotateResult = {
  readonly privateKeyName: string;
  readonly files: readonly { readonly file: string; readonly values: number }[];
  /** Where the new private key was written. */
  readonly keysFile: string;
};

/**
 * Re-encrypt every file of one environment to a new keypair, in one step: decrypt everything first
 * (so a wrong key changes nothing), then write each file, then the new private key. All `files` must
 * share a file name (`.env.production`), because they share a key name.
 */
export function rotateEnvFiles(files: readonly string[], options: { readonly root: string; readonly env?: Readonly<Record<string, string | undefined>> }): RotateResult {
  const first = files[0];
  if (first === undefined) throw new Error('no files to rotate');
  const names = keyNamesFor(path.basename(first));
  if (files.some(file => keyNamesFor(path.basename(file)).privateKey !== names.privateKey)) {
    throw new Error('rotate takes files of one environment at a time');
  }
  const pair = generateKeypair();
  const plans = files.map(file => {
    const text = readFileSync(file, 'utf8');
    const found: FoundPrivateKey | undefined = findPrivateKey(file, { root: options.root, env: options.env ?? process.env });
    let next = text;
    let values = 0;
    for (const [key, entry] of envValues(parseEnv(text))) {
      if (key === names.publicKey) {
        next = setEnvValue(next, key, pair.publicKey);
        continue;
      }
      if (!isEncrypted(entry.value)) continue;
      if (found === undefined) throw new Error(`${path.relative(options.root, file)}: no private key to decrypt ${key}`);
      next = setEnvValue(next, key, encryptValue(decryptWithAny(entry.value, found.keys, key), pair.publicKey));
      values++;
    }
    if (readEnvValue(parseEnv(text), names.publicKey) === undefined) next = `${envHeader(path.basename(file), pair.publicKey)}\n${next}`;
    return { file, next, values };
  });
  for (const plan of plans) atomicWrite(plan.file, plan.next);
  const keysFile = path.join(options.root, KEYS_FILE);
  writePrivateKey(keysFile, names.privateKey, pair.privateKey, path.basename(first));
  return { privateKeyName: names.privateKey, files: plans.map(({ file, values }) => ({ file, values })), keysFile };
}

function decryptWithAny(value: string, privateKeys: readonly string[], key: string): string {
  for (const privateKey of privateKeys) {
    try {
      return decryptValue(value, privateKey);
    } catch {
      // Try the next key; the error below names the value when none fits.
    }
  }
  throw new Error(`${key} cannot be decrypted with the available private key`);
}

/**
 * Write through a temp file with an unguessable name, created exclusively (never through a symlink
 * planted at that name) with the original file's mode, or owner-only for a new file, then rename.
 */
function atomicWrite(file: string, text: string): void {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  writeFileSync(temp, text, { flag: 'wx', mode });
  renameSync(temp, file);
}
