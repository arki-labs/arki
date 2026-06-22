/**
 * Storage - S3 Adapter
 *
 * Implements storage using AWS S3 (or compatible services)
 */

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import { AwsS3StorageAdapter } from '@flystorage/aws-s3';
import { FileStorage } from '@flystorage/file-storage';
import { env } from '../env';
import type {
  S3StorageConfig,
  SignedUrlOptions,
  StorageAdapter,
  StoredFile,
  StoredFileMetadata,
  StoreOptions,
} from './types';

function isNotFoundError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name: string }).name;
    return name === 'NotFound' || name === 'NoSuchKey';
  }
  return false;
}

export class S3StorageAdapter implements StorageAdapter {
  private storage: FileStorage;
  private config: S3StorageConfig;
  private client: S3Client;

  constructor(config: S3StorageConfig) {
    this.config = config;

    const accessKeyId = config.accessKeyId ?? env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = config.secretAccessKey ?? env.AWS_SECRET_ACCESS_KEY;
    const endpoint = config.endpoint ?? env.AWS_ENDPOINT_URL;

    this.client = new S3Client({
      region: config.region ?? env.AWS_REGION,
      credentials:
        accessKeyId && secretAccessKey
          ? {
              accessKeyId,
              secretAccessKey,
              ...(env.AWS_SESSION_TOKEN && { sessionToken: env.AWS_SESSION_TOKEN }),
            }
          : undefined,
      ...(endpoint && { endpoint }),
    });

    const adapter = new AwsS3StorageAdapter(this.client, {
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
      cacheControl: options?.cacheControl,
      visibility: options?.visibility,
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

  async getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const Key = this.getFullKey(key);
    const expiresIn = options?.expiresIn ?? 3600;

    if (options?.operation === 'put') {
      const command = new PutObjectCommand({ Bucket: this.config.bucket, Key });
      return presign(this.client, command, { expiresIn });
    }

    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key,
      ResponseContentDisposition: options?.disposition
        ? `${options.disposition}${options.filename ? `; filename="${options.filename}"` : ''}`
        : undefined,
    });
    return presign(this.client, command, { expiresIn });
  }

  async getMetadata(key: string): Promise<StoredFileMetadata | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.getFullKey(key) }),
      );

      return {
        key,
        size: response.ContentLength ?? 0,
        contentType: response.ContentType ?? 'application/octet-stream',
        lastModified: response.LastModified ?? new Date(),
        etag: response.ETag ?? '',
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
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
