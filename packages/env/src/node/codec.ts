/**
 * The dotenvx 2.x file format: parse and edit `.env` text without losing a byte of the lines you
 * did not touch, and encrypt or decrypt one value.
 *
 * A value is encrypted as `encrypted:` + base64 of ECIES over secp256k1 (HKDF-SHA256, AES-256-GCM,
 * an ephemeral key per value), exactly what `eciesjs` produces with its defaults. The same bytes are
 * what dotenvx writes, so files move freely between `dot env` and the `dotenvx` CLI.
 */
import { Buffer } from 'node:buffer';

import { decrypt, encrypt, PrivateKey } from 'eciesjs';
import { Config } from 'eciesjs/config';

import { ENCRYPTED_PREFIX } from '../core/define-env.js';

export { ENCRYPTED_PREFIX } from '../core/define-env.js';

/** Pinned so a process that changes the global `ECIES_CONFIG` cannot change our bytes. */
const DOTENVX_ECIES = new Config();

const KEY_PATTERN = /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=(.*)$/;
const QUOTES = ['"', "'", '`'] as const;

/** One `KEY=value` assignment: its decoded value and the lines it spans (`end` exclusive). */
export type EnvEntry = {
  readonly key: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
};

/** A parsed `.env` file: its lines as written, and every assignment in order. */
export type EnvDocument = {
  readonly lines: readonly string[];
  readonly entries: readonly EnvEntry[];
};

/** A keypair as dotenvx writes it: a compressed public key (66 hex chars), a private key (64). */
export type EnvKeypair = { readonly publicKey: string; readonly privateKey: string };

/**
 * Parse `.env` text the way `dotenv` reads it: `export` prefixes, `#` comments, single, double and
 * backtick quotes, multi-line quoted values, and `\n` / `\r` expanded inside double quotes. An
 * unquoted value ends at the first `#`. A key that appears twice keeps both entries; readers take the
 * last one, as dotenv does.
 */
export function parseEnv(text: string): EnvDocument {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const entries: EnvEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = KEY_PATTERN.exec(lines[index] ?? '');
    if (match === null) continue;
    const key = match[1] ?? '';
    let raw = (match[2] ?? '').trimStart();
    const start = index;
    const quote = QUOTES.find(candidate => raw.startsWith(candidate));
    if (quote !== undefined) {
      while (closingQuote(raw, quote) === -1 && index + 1 < lines.length) {
        index++;
        raw += `\n${lines[index] ?? ''}`;
      }
    }
    entries.push({ key, value: decodeValue(raw, quote), start, end: index + 1 });
  }
  return { lines, entries };
}

/** The last value of `key`, or `undefined`. */
export function readEnvValue(document: EnvDocument, key: string): string | undefined {
  return document.entries.findLast(entry => entry.key === key)?.value;
}

/** Every key with its last value, in first-seen order. */
export function envValues(document: EnvDocument): Map<string, EnvEntry> {
  const values = new Map<string, EnvEntry>();
  for (const entry of document.entries) values.set(entry.key, entry);
  return values;
}

/**
 * The text with `key` set to `value`. An existing assignment (the last one) is rewritten in place;
 * a new key is appended. Every other line is kept as written.
 */
export function setEnvValue(text: string, key: string, value: string): string {
  const document = parseEnv(text);
  const line = `${key}=${encodeValue(value)}`;
  const existing = document.entries.findLast(entry => entry.key === key);
  if (existing === undefined) {
    const body = document.lines.join('\n');
    const separator = body === '' || body.endsWith('\n') ? '' : '\n';
    return `${body}${separator}${line}\n`;
  }
  return [...document.lines.slice(0, existing.start), line, ...document.lines.slice(existing.end)].join('\n');
}

/** The text without any assignment of `key`. */
export function removeEnvValue(text: string, key: string): string {
  const document = parseEnv(text);
  const dropped = new Set<number>();
  for (const entry of document.entries) {
    if (entry.key !== key) continue;
    for (let line = entry.start; line < entry.end; line++) dropped.add(line);
  }
  return document.lines.filter((_, index) => !dropped.has(index)).join('\n');
}

/** True for a value written by {@link encryptValue} (or by dotenvx). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/** Encrypt `value` to a compressed or uncompressed secp256k1 public key (hex). */
export function encryptValue(value: string, publicKey: string): string {
  const sealed = encrypt(publicKey, new TextEncoder().encode(value), DOTENVX_ECIES);
  return `${ENCRYPTED_PREFIX}${Buffer.from(sealed).toString('base64')}`;
}

/** Decrypt a value written by {@link encryptValue}. Throws when the key does not match. */
export function decryptValue(value: string, privateKey: string): string {
  const sealed = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
  return new TextDecoder('utf-8', { fatal: true }).decode(decrypt(privateKey, sealed, DOTENVX_ECIES));
}

/** A new random keypair. */
export function generateKeypair(): EnvKeypair {
  const secret = new PrivateKey(undefined, DOTENVX_ECIES.ellipticCurve);
  return { publicKey: secret.publicKey.toHex(true), privateKey: secret.toHex() };
}

/** The compressed public key of a private key (hex). Throws on an invalid key. */
export function publicKeyOf(privateKey: string): string {
  return PrivateKey.fromHex(privateKey, DOTENVX_ECIES.ellipticCurve).publicKey.toHex(true);
}

/**
 * The key names dotenvx uses for a file: `.env` → `DOTENV_PUBLIC_KEY` / `DOTENV_PRIVATE_KEY`,
 * `.env.production` → `..._PRODUCTION`, `.env.ci.local` → `..._CI_LOCAL`.
 */
export function keyNamesFor(fileName: string): { readonly publicKey: string; readonly privateKey: string } {
  const base = fileName.toLowerCase().replace(/\.txt$/, '');
  const suffix = base.startsWith('.env.') ? `_${base.slice('.env.'.length).replaceAll(/[^a-z0-9]+/g, '_').toUpperCase()}` : '';
  return { publicKey: `DOTENV_PUBLIC_KEY${suffix}`, privateKey: `DOTENV_PRIVATE_KEY${suffix}` };
}

/** True for the `DOTENV_PUBLIC_KEY*` / `DOTENV_PRIVATE_KEY*` names, which are never app values. */
export function isKeyName(key: string): boolean {
  return key.startsWith('DOTENV_PUBLIC_KEY') || key.startsWith('DOTENV_PRIVATE_KEY');
}

/** The dotenvx header for a file: banner, public key, and a `# <file>` line. */
export function envHeader(fileName: string, publicKey: string): string {
  return [
    '#/-------------------[DOTENV_PUBLIC_KEY]--------------------/',
    '#/            public-key encryption for .env files          /',
    '#/       [how it works](https://dotenvx.com/encryption)     /',
    '#/----------------------------------------------------------/',
    `${keyNamesFor(fileName).publicKey}="${publicKey}"`,
    '',
    `# ${fileName}`,
  ].join('\n');
}

function closingQuote(raw: string, quote: string): number {
  for (let index = 1; index < raw.length; index++) {
    if (raw[index] === quote && raw[index - 1] !== '\\') return index;
  }
  return -1;
}

function decodeValue(raw: string, quote: string | undefined): string {
  if (quote === undefined) return raw.split('#')[0]?.trim() ?? '';
  const close = closingQuote(raw, quote);
  const inner = close === -1 ? raw.slice(1) : raw.slice(1, close);
  return quote === '"' ? inner.replaceAll('\\n', '\n').replaceAll('\\r', '\r') : inner;
}

/**
 * The first quoting that reads back as exactly `value`, in one entry: double quotes (newlines as
 * `\n`), then single, then backticks. A value no quoting can carry (it holds every quote character
 * and a line break, say) is refused rather than written in a form that could inject other keys.
 */
function encodeValue(value: string): string {
  const candidates = [`"${value.replaceAll('\r', '\\r').replaceAll('\n', '\\n')}"`, `'${value}'`, `\`${value}\``];
  for (const candidate of candidates) {
    const document = parseEnv(`K=${candidate}`);
    if (document.entries.length === 1 && document.entries[0]?.value === value) return candidate;
  }
  throw new Error('this value cannot be stored in a .env file: it holds every quote character together with a line break or an escape sequence');
}
