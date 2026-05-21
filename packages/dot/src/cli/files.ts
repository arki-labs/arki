/**
 * Filesystem helpers for the `dot new` scaffold.
 *
 * Kept deliberately small and dependency-free so the scaffolding code path
 * stays auditable. The scaffold first builds an in-memory list of
 * {@link FileOperation} entries describing every file it WOULD write, then
 * either prints them (`--dry-run`) or commits them to disk.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Action the generator will take for a particular file.
 *
 * - `create` — file does not yet exist at the target path.
 * - `overwrite` — file exists; the generator will replace it (only when
 *   `--force` was passed).
 * - `skip` — file exists and the generator refuses to overwrite without
 *   `--force`. Surfaced in dry-run output and converted to a failure on
 *   real runs.
 */
export type FileOperationAction = 'create' | 'overwrite' | 'skip';

/**
 * Description of a single file the scaffold plans to emit.
 *
 * `path` is always relative to the target directory so the envelope is
 * portable across machines. `contentHash` is sha256 of the rendered bytes
 * — agents can use it to confirm the file we wrote matches the file we
 * planned.
 */
export type FileOperation = {
  readonly path: string;
  readonly action: FileOperationAction;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly reason: string;
  /**
   * Rendered file contents. Internal to the generator — NOT emitted in the
   * JSON envelope. Kept on the in-memory plan so a non-dry-run can write
   * the same bytes that produced `contentHash`.
   */
  readonly content: string;
};

/**
 * Walk a template directory and return the relative paths of every file.
 *
 * Subdirectories are descended into; symlinks and non-regular files are
 * ignored. Paths are returned without a leading separator and are sorted
 * lexicographically for deterministic output.
 */
export async function collectTemplateFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full));
      }
    }
  }

  await walk(root);
  out.sort();
  return out;
}

/** Compute the sha256 hex digest of a string payload (utf-8 encoded). */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Byte length of a utf-8 string. Wrapper exists so the call site is obvious. */
export function utf8ByteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/** Return `true` when a regular file exists at the given path. */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const result = await stat(filePath);
    return result.isFile();
  } catch {
    return false;
  }
}

/** Return `true` when a directory exists and contains at least one entry. */
export async function directoryIsNonEmpty(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Write a single file, creating parent directories as needed.
 */
export async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

/**
 * Read a template file from disk. Trivially thin wrapper around
 * `fs.readFile`, but exists so the scaffold imports stay symmetric with
 * its helpers.
 */
export async function readTemplate(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}
