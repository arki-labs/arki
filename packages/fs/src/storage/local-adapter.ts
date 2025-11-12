/**
 * Storage - Local Filesystem Adapter
 *
 * Implements storage using the local filesystem
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from '../local/glob';
import type { LocalStorageConfig, StorageAdapter, StoredFile, StoreOptions } from './types';

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private config: LocalStorageConfig) {}

  async put(key: string, data: Buffer, options?: StoreOptions): Promise<StoredFile> {
    const filePath = this.getFilePath(key);
    const dir = path.dirname(filePath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(filePath, data);

    // Get file stats
    const stats = await fs.stat(filePath);

    return {
      key,
      size: stats.size,
      url: this.getUrl(key),
      contentType: options?.contentType,
    };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const filePath = this.getFilePath(key);
      return await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const filePath = this.getFilePath(key);
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.delete(key)));
  }

  async exists(key: string): Promise<boolean> {
    try {
      const filePath = this.getFilePath(key);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  getUrl(key: string): string {
    return `${this.config.baseUrl}/${key}`;
  }

  async list(prefix: string): Promise<string[]> {
    const pattern = path.join(this.config.basePath, prefix, '**/*');
    const files = await glob(pattern, { nodir: true });

    return files.map((file) => path.relative(this.config.basePath, file));
  }

  private getFilePath(key: string): string {
    return path.join(this.config.basePath, key);
  }
}

/**
 * Create a local storage adapter
 */
export function createLocalStorageAdapter(config: LocalStorageConfig): StorageAdapter {
  return new LocalStorageAdapter(config);
}
