/**
 * Storage - S3 Adapter
 *
 * Implements storage using AWS S3 (or compatible services)
 */

import { S3Client } from '@aws-sdk/client-s3';
import { AwsS3StorageAdapter } from '@flystorage/aws-s3';
import { FileStorage } from '@flystorage/file-storage';
import { env } from '../env';
import type { S3StorageConfig, StorageAdapter, StoredFile, StoreOptions } from './types';

export class S3StorageAdapter implements StorageAdapter {
  private storage: FileStorage;
  private config: S3StorageConfig;

  constructor(config: S3StorageConfig) {
    this.config = config;

    const client = new S3Client({
      region: config.region ?? env.AWS_REGION,
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              ...(env.AWS_SESSION_TOKEN && { sessionToken: env.AWS_SESSION_TOKEN }),
            }
          : undefined,
      ...(env.AWS_ENDPOINT_URL && { endpoint: env.AWS_ENDPOINT_URL }),
    });

    const adapter = new AwsS3StorageAdapter(client, {
      bucket: config.bucket,
      prefix: config.prefix ?? '',
      region: config.region ?? env.AWS_REGION,
    });

    this.storage = new FileStorage(adapter);
  }

  async put(key: string, data: Buffer, options?: StoreOptions): Promise<StoredFile> {
    const fullKey = this.getFullKey(key);

    await this.storage.write(fullKey, data, {
      mimeType: options?.contentType,
      metadata: options?.metadata,
    });

    // Get file size
    const stat = await this.storage.statFile(fullKey);

    return {
      key,
      size: stat.size ?? data.length,
      url: this.getUrl(key),
      contentType: options?.contentType,
    };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const fullKey = this.getFullKey(key);
      const content = await this.storage.read(fullKey);

      // Convert Readable stream to Buffer
      if (content instanceof Buffer) {
        return content;
      }

      // Handle string content
      if (typeof content === 'string') {
        return Buffer.from(content);
      }

      // Handle Readable stream
      const chunks: Uint8Array[] = [];
      for await (const chunk of content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if ((error as Error).message.includes('NoSuchKey')) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const fullKey = this.getFullKey(key);
      await this.storage.deleteFile(fullKey);
    } catch (error) {
      if ((error as Error).message.includes('NoSuchKey')) {
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
      const fullKey = this.getFullKey(key);
      return await this.storage.fileExists(fullKey);
    } catch {
      return false;
    }
  }

  getUrl(key: string): string {
    return `${this.config.baseUrl}/${key}`;
  }

  async list(prefix: string): Promise<string[]> {
    const fullPrefix = this.getFullKey(prefix);
    const files: string[] = [];

    for await (const item of this.storage.list(fullPrefix)) {
      if (item.isFile) {
        // Remove the adapter's prefix if it exists
        const key = this.config.prefix
          ? item.path.replace(`${this.config.prefix}/`, '')
          : item.path;
        files.push(key);
      }
    }

    return files;
  }

  private getFullKey(key: string): string {
    if (this.config.prefix) {
      return `${this.config.prefix}/${key}`;
    }
    return key;
  }
}

/**
 * Create an S3 storage adapter
 */
export function createS3StorageAdapter(config: S3StorageConfig): StorageAdapter {
  return new S3StorageAdapter(config);
}
