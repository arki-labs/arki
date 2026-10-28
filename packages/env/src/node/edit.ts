/**
 * File edits behind `dot env init | set | encrypt | decrypt | rotate`. Each write goes to a temp file
 * first and is renamed into place, so an interrupted command never leaves half a file.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { isFailure } from '@arki/failure';

import type { EnvPrivateKey, EnvPublicKey } from './key-schemas.js';
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
import {
  DecryptionFailed,
  FileWriteFailed,
  MissingPrivateKey,
  MissingPublicKey,
  RotationIncomplete,
} from './errors.js';
import { readEnvText, writeEnvText } from './files.js';
import { parsePublicKey } from './key-schemas.js';
import { findPrivateKey, KEYS_FILE, keysFileCandidates, writePrivateKey } from './keys.js';
import { nodeOperation } from './operation-telemetry.js';

/** The public key in a file's header, or `undefined` when it has none. */
export function publicKeyIn(file: string) {
  if (!existsSync(file)) return;
  const text = readEnvText(file);
  if (isFailure(text)) return text;
  const key = readEnvValue(parseEnv(text), keyNamesFor(path.basename(file)).publicKey);
  if (key === undefined) return;
  return parsePublicKey(key);
}

/** What `initEnvFile` did. */
export type InitResult = {
  readonly file: string;
  readonly publicKey: EnvPublicKey;
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
) {
  return nodeOperation('init', () => {
    const existing = publicKeyIn(file);
    if (isFailure(existing)) return existing;
    if (existing !== undefined) return { file, publicKey: existing, headerAdded: false } satisfies InitResult;
    const names = keyNamesFor(path.basename(file));
    const found = findPrivateKey(file, { root: options.root, env: options.env ?? process.env });
    if (isFailure(found)) return found;
    const reused = found?.keys[0];
    let publicKey: EnvPublicKey;
    let keysWritten: string | undefined;
    if (reused === undefined) {
      const pair = generateKeypair();
      if (isFailure(pair)) return pair;
      keysWritten = path.join(options.root, KEYS_FILE);
      const written = writePrivateKey(keysWritten, names.privateKey, pair.privateKey, path.basename(file));
      if (isFailure(written)) return written;
      publicKey = pair.publicKey;
    } else {
      publicKey = publicKeyOf(reused);
    }
    const body = existsSync(file) ? readEnvText(file) : '';
    if (isFailure(body)) return body;
    const written = writeEnvText(file, `${envHeader(path.basename(file), publicKey)}\n${body}`);
    if (isFailure(written)) return written;
    return keysWritten === undefined
      ? { file, publicKey, headerAdded: true }
      : { file, publicKey, headerAdded: true, keysWritten };
  });
}

/**
 * Set `key` in `file`, encrypted to the file's public key unless `plain`. Returns `false` when the
 * file already held exactly this plaintext value (an encrypted value is always rewritten, because
 * the same plaintext never encrypts to the same bytes).
 */
export function setEnvFileValue(file: string, key: string, value: string, options: { readonly plain: boolean }) {
  return nodeOperation('set', () => {
    const text = existsSync(file) ? readEnvText(file) : '';
    if (isFailure(text)) return text;
    let stored = value;
    if (!options.plain) {
      const publicKey = readEnvValue(parseEnv(text), keyNamesFor(path.basename(file)).publicKey);
      if (publicKey === undefined) return MissingPublicKey({ file });
      const parsedKey = parsePublicKey(publicKey);
      if (isFailure(parsedKey)) return parsedKey;
      const encrypted = encryptValue(value, parsedKey);
      if (isFailure(encrypted)) return encrypted;
      stored = encrypted;
    }
    const next = setEnvValue(text, key, stored);
    if (isFailure(next)) return next;
    if (next === text) return false;
    const written = writeEnvText(file, next);
    return isFailure(written) ? written : true;
  });
}

/** Encrypt plaintext values in place: the listed keys, or every value. Returns the keys encrypted. */
export function encryptEnvFile(file: string, keys?: readonly string[]) {
  return nodeOperation('encrypt_file', () => {
    const text = readEnvText(file);
    if (isFailure(text)) return text;
    const publicKey = readEnvValue(parseEnv(text), keyNamesFor(path.basename(file)).publicKey);
    if (publicKey === undefined) return MissingPublicKey({ file });
    const parsedKey = parsePublicKey(publicKey);
    if (isFailure(parsedKey)) return parsedKey;
    let next = text;
    const done: string[] = [];
    for (const [key, entry] of envValues(parseEnv(text))) {
      if (isKeyName(key) || isEncrypted(entry.value) || (keys !== undefined && !keys.includes(key))) continue;
      const encrypted = encryptValue(entry.value, parsedKey);
      if (isFailure(encrypted)) return encrypted;
      const updated = setEnvValue(next, key, encrypted);
      if (isFailure(updated)) return updated;
      next = updated;
      done.push(key);
    }
    if (done.length > 0) {
      const written = writeEnvText(file, next);
      if (isFailure(written)) return written;
    }
    return done;
  });
}

/** Decrypt values in place with `privateKeys`: the listed keys, or every value. Returns the keys decrypted. */
export function decryptEnvFile(file: string, privateKeys: readonly EnvPrivateKey[], keys?: readonly string[]) {
  return nodeOperation('decrypt_file', () => {
    const text = readEnvText(file);
    if (isFailure(text)) return text;
    let next = text;
    const done: string[] = [];
    for (const [key, entry] of envValues(parseEnv(text))) {
      if (!isEncrypted(entry.value) || (keys !== undefined && !keys.includes(key))) continue;
      const decrypted = decryptWithAny(entry.value, privateKeys);
      if (isFailure(decrypted)) return decrypted;
      const updated = setEnvValue(next, key, decrypted);
      if (isFailure(updated)) return updated;
      next = updated;
      done.push(key);
    }
    if (done.length > 0) {
      const written = writeEnvText(file, next);
      if (isFailure(written)) return written;
    }
    return done;
  });
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
export function rotateEnvFiles(
  files: readonly string[],
  options: { readonly root: string; readonly env?: Readonly<Record<string, string | undefined>> },
) {
  const first = files[0];
  if (first === undefined) throw new Error('no files to rotate');
  const names = keyNamesFor(path.basename(first));
  if (files.some(file => keyNamesFor(path.basename(file)).privateKey !== names.privateKey)) {
    throw new Error('rotate takes files of one environment at a time');
  }
  return nodeOperation('rotate', () => {
    const pair = generateKeypair();
    if (isFailure(pair)) return pair;
    const previousKeys = new Set<EnvPrivateKey>();
    const keysFile = path.join(options.root, KEYS_FILE);
    const keyStores = new Set([keysFile]);
    const plans: { file: string; next: string; values: number }[] = [];
    for (const file of files) {
      for (const candidate of keysFileCandidates(file, options.root)) {
        if (existsSync(candidate)) keyStores.add(candidate);
      }
      const text = readEnvText(file);
      if (isFailure(text)) return text;
      const found = findPrivateKey(file, { root: options.root, env: options.env ?? process.env });
      if (isFailure(found)) return found;
      for (const key of found?.keys ?? []) previousKeys.add(key);
      let next = text;
      let values = 0;
      for (const [key, entry] of envValues(parseEnv(text))) {
        let value: string;
        if (key === names.publicKey) value = pair.publicKey;
        else if (isEncrypted(entry.value)) {
          if (found === undefined) return MissingPrivateKey({ file });
          const decrypted = decryptWithAny(entry.value, found.keys);
          if (isFailure(decrypted)) return decrypted;
          const encrypted = encryptValue(decrypted, pair.publicKey);
          if (isFailure(encrypted)) return encrypted;
          value = encrypted;
          values++;
        } else continue;
        const updated = setEnvValue(next, key, value);
        if (isFailure(updated)) return updated;
        next = updated;
      }
      if (readEnvValue(parseEnv(text), names.publicKey) === undefined)
        next = `${envHeader(path.basename(file), pair.publicKey)}\n${next}`;
      plans.push({ file, next, values });
    }
    // Persist both generations BEFORE any ciphertext changes. An interruption at any later point
    // leaves every old/new file recoverable from this key store, including a partial rotation.
    for (const store of keyStores) {
      const staged = writePrivateKey(store, names.privateKey, pair.privateKey, path.basename(first), {
        preserve: [...previousKeys],
      });
      if (isFailure(staged)) return staged;
    }
    let completedFiles = 0;
    for (const plan of plans) {
      const written = writeEnvText(plan.file, plan.next);
      if (isFailure(written))
        return RotationIncomplete({ keysFile, completedFiles, totalFiles: plans.length }, { cause: written });
      completedFiles++;
    }
    // Do not retire the old generation until every committed file reads back exactly as planned.
    for (const plan of plans) {
      const confirmed = readEnvText(plan.file);
      if (isFailure(confirmed) || confirmed !== plan.next)
        return RotationIncomplete(
          { keysFile, completedFiles, totalFiles: plans.length },
          { cause: isFailure(confirmed) ? confirmed : FileWriteFailed({ file: plan.file }) },
        );
    }
    for (const store of keyStores) {
      const finalized = writePrivateKey(store, names.privateKey, pair.privateKey, path.basename(first));
      if (isFailure(finalized))
        return RotationIncomplete({ keysFile, completedFiles, totalFiles: plans.length }, { cause: finalized });
    }
    return {
      privateKeyName: names.privateKey,
      files: plans.map(({ file, values }) => ({ file, values })),
      keysFile,
    } satisfies RotateResult;
  });
}

function decryptWithAny(value: string, privateKeys: readonly EnvPrivateKey[]) {
  for (const privateKey of privateKeys) {
    const decrypted = decryptValue(value, privateKey);
    if (!isFailure(decrypted)) return decrypted;
  }
  return DecryptionFailed();
}
