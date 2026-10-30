/** Local storage requires an application-owned base directory. Descendant symlinks are refused. */
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { parse } from '@arki/schema';

import type {
  LocalStorageConfig,
  SignedUrlOptions,
  StorageAdapter,
  StorageCallOptions,
  StoredFile,
  StoreOptions,
} from './types.js';
import { StorageCancelled, StorageRejected } from './failures.js';
import { observeFs, storageErrorFacts, storageReadFailure, storageWriteFailure } from './operation.js';

// The same key contract owns reads, writes, metadata, deletion and list prefixes.
const keySchema = z
  .string()
  .min(1)
  .refine(
    key =>
      !path.isAbsolute(key) &&
      !key.includes('\\') &&
      !key.includes('\0') &&
      key.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
    'Use a relative object key without dot segments.',
  );
const prefixSchema = z.union([z.literal(''), keySchema]);

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly config: LocalStorageConfig) {}

  private async filePath(key: string, create = false, prefix = false) {
    const parsed = parse(prefix ? prefixSchema : keySchema, key);
    if (isFailure(parsed)) return parsed;
    if (create) await fs.mkdir(this.config.basePath, { recursive: true });
    const base = await fs.realpath(this.config.basePath);
    const target = path.join(base, parsed);
    let current = base;
    for (const part of parsed.split('/').filter(Boolean)) {
      current = path.join(current, part);
      try {
        const entry = await fs.lstat(current);
        if (entry.isSymbolicLink()) return StorageRejected();
      } catch (error) {
        if (storageErrorFacts(error)?.code === 'ENOENT') break;
        throw error;
      }
    }
    return target;
  }

  put(key: string, data: Buffer, options?: StoreOptions) {
    return observeFs('fs.local.put', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      let dispatched = false;
      try {
        const file = await this.filePath(key, true);
        if (isFailure(file)) return file;
        await fs.mkdir(path.dirname(file), { recursive: true });
        const checked = await this.filePath(key);
        if (isFailure(checked)) return checked;
        if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
        // O_NOFOLLOW rejects a leaf swapped for a symlink after validation.
        dispatched = true;
        const handle = await fs.open(
          checked,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        );
        try {
          await handle.writeFile(data, { signal: options?.signal });
        } finally {
          await handle.close();
        }
        return {
          key,
          size: data.byteLength,
          url: this.getUrl(key),
          contentType: options?.contentType,
        } satisfies StoredFile;
      } catch (error) {
        return dispatched ? storageWriteFailure(error) : storageReadFailure(error, options?.signal);
      }
    });
  }

  get(key: string, options?: StorageCallOptions) {
    return observeFs('fs.local.get', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      try {
        const file = await this.filePath(key);
        if (isFailure(file)) return file;
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          return await handle.readFile({ signal: options?.signal });
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (storageErrorFacts(error)?.code === 'ENOENT') return null;
        return storageReadFailure(error, options?.signal);
      }
    });
  }

  delete(key: string, options?: StorageCallOptions) {
    return observeFs('fs.local.delete', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      let dispatched = false;
      try {
        const file = await this.filePath(key);
        if (isFailure(file)) return file;
        if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
        dispatched = true;
        await fs.unlink(file);
        return;
      } catch (error) {
        if (storageErrorFacts(error)?.code === 'ENOENT') return;
        return dispatched ? storageWriteFailure(error) : storageReadFailure(error, options?.signal);
      }
    });
  }

  deleteMany(keys: string[], options?: StorageCallOptions) {
    return observeFs('fs.local.delete_many', async () => {
      // Stop on the first failure; earlier confirmed deletes stay confirmed and are idempotent.
      for (const key of keys) {
        const outcome = await this.delete(key, options);
        if (isFailure(outcome)) return outcome;
      }
      return;
    });
  }

  exists(key: string, options?: StorageCallOptions) {
    return observeFs('fs.local.exists', async () => {
      const metadata = await this.getMetadata(key, options);
      return isFailure(metadata) ? metadata : metadata !== null;
    });
  }

  getUrl(key: string): string {
    return `${this.config.baseUrl}/${key}`;
  }

  getSignedUrl(key: string, options?: SignedUrlOptions) {
    return observeFs('fs.local.sign', () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      const parsed = parse(keySchema, key);
      return isFailure(parsed) ? parsed : this.getUrl(parsed);
    });
  }

  getMetadata(key: string, options?: StorageCallOptions) {
    return observeFs('fs.local.metadata', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      try {
        const file = await this.filePath(key);
        if (isFailure(file)) return file;
        const stats = await fs.lstat(file);
        if (stats.isSymbolicLink()) return StorageRejected();
        if (!stats.isFile()) return StorageRejected();
        return {
          key,
          size: stats.size,
          contentType: CONTENT_TYPE_BY_EXT[path.extname(key).toLowerCase()] ?? 'application/octet-stream',
          lastModified: stats.mtime,
          etag: '',
        };
      } catch (error) {
        if (storageErrorFacts(error)?.code === 'ENOENT') return null;
        return storageReadFailure(error, options?.signal);
      }
    });
  }

  list(prefix: string, options?: StorageCallOptions) {
    return observeFs('fs.local.list', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      try {
        const start = await this.filePath(prefix, false, true);
        if (isFailure(start)) return start;
        const base = await fs.realpath(this.config.basePath);
        const files: string[] = [];
        const visit = async (directory: string): Promise<void> => {
          options?.signal?.throwIfAborted();
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) await visit(file);
            else if (entry.isFile()) files.push(path.relative(base, file).split(path.sep).join('/'));
          }
        };
        await visit(start);
        return files;
      } catch (error) {
        if (storageErrorFacts(error)?.code === 'ENOENT') return [];
        return storageReadFailure(error, options?.signal);
      }
    });
  }
}

export function createLocalStorageAdapter(config: LocalStorageConfig) {
  return new LocalStorageAdapter(config);
}
