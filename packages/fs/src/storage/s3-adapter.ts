/** S3 provider boundary. Missing objects are values; outages and unconfirmed writes are failures. */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';

import { isFailure, UnexpectedDefect } from '@arki/failure';

import type {
  S3StorageConfig,
  SignedUploadAdapter,
  SignedUrlOptions,
  StorageCallOptions,
  StoredFile,
  StoreOptions,
} from './types.js';
import { env } from '../env';
import { StorageCancelled } from './failures.js';
import { observeFs, storageErrorFacts, storageReadFailure, storageWriteFailure } from './operation.js';

const missing = (error: unknown) => {
  const facts = storageErrorFacts(error);
  return facts?.name === 'NotFound' || facts?.name === 'NoSuchKey';
};

export class S3StorageAdapter implements SignedUploadAdapter {
  readonly capabilities = { signedPut: true } as const;
  private readonly client: S3Client;
  constructor(private readonly config: S3StorageConfig) {
    const accessKeyId = config.accessKeyId ?? env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = config.secretAccessKey ?? env.AWS_SECRET_ACCESS_KEY;
    const endpoint = config.endpoint ?? env.AWS_ENDPOINT_URL;

    this.client = new S3Client({
      // A missing write acknowledgement is uncertainty, never permission for an SDK replay.
      maxAttempts: 1,
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
      // The SDK default ('WHEN_SUPPORTED') puts the CRC32 of an EMPTY body into every
      // presigned PUT URL, so a real upload would fail the checksum. Checksums only where
      // an operation requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  put(key: string, data: Buffer, options?: StoreOptions) {
    return observeFs('fs.s3.put', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      try {
        const response = await this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: this.getFullKey(key),
            Body: data,
            ContentType: options?.contentType,
            Metadata: options?.metadata,
            CacheControl: options?.cacheControl,
            ACL:
              options?.visibility === 'public'
                ? 'public-read'
                : options?.visibility === 'private'
                  ? 'private'
                  : undefined,
          }),
          { abortSignal: options?.signal },
        );
        // PUT acknowledgement confirms this write; no fallible follow-up HEAD can erase it.
        return {
          key,
          size: data.byteLength,
          url: this.getUrl(key),
          contentType: options?.contentType,
          etag: response.ETag,
        } satisfies StoredFile;
      } catch (error) {
        return storageWriteFailure(error);
      }
    });
  }

  get(key: string, options?: StorageCallOptions) {
    return observeFs('fs.s3.get', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      try {
        const response = await this.client.send(
          new GetObjectCommand({ Bucket: this.config.bucket, Key: this.getFullKey(key) }),
          { abortSignal: options?.signal },
        );
        if (!response.Body) return UnexpectedDefect({ cause: new Error('GET returned no body') });
        return Buffer.from(await response.Body.transformToByteArray());
      } catch (error) {
        return missing(error) ? null : storageReadFailure(error, options?.signal);
      }
    });
  }

  delete(key: string, options?: StorageCallOptions) {
    return observeFs('fs.s3.delete', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.getFullKey(key) }), {
          abortSignal: options?.signal,
        });
        return;
      } catch (error) {
        return missing(error) ? undefined : storageWriteFailure(error);
      }
    });
  }

  deleteMany(keys: string[], options?: StorageCallOptions) {
    return observeFs('fs.s3.delete_many', async () => {
      for (const key of keys) {
        const result = await this.delete(key, options);
        if (isFailure(result)) return result;
      }
      return;
    });
  }

  exists(key: string, options?: StorageCallOptions) {
    return observeFs('fs.s3.exists', async () => {
      const result = await this.getMetadata(key, options);
      return isFailure(result) ? result : result !== null;
    });
  }

  getUrl(key: string): string {
    return `${this.config.baseUrl}/${key}`;
  }

  getSignedUrl(key: string, options?: SignedUrlOptions) {
    return observeFs('fs.s3.sign', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      const Key = this.getFullKey(key);
      const expiresIn = options?.expiresIn ?? 3600;
      try {
        if (options?.operation === 'put') {
          return await presign(
            this.client,
            new PutObjectCommand({
              Bucket: this.config.bucket,
              Key,
              ContentType: options.contentType,
              ContentLength: options.contentLength,
              IfNoneMatch: options.ifNoneMatch,
            }),
            { expiresIn, signableHeaders: new Set(['content-type']) },
          );
        }
        return await presign(
          this.client,
          new GetObjectCommand({
            Bucket: this.config.bucket,
            Key,
            ResponseContentDisposition: options?.disposition
              ? `${options.disposition}${options.filename ? `; filename="${options.filename}"` : ''}`
              : undefined,
          }),
          { expiresIn },
        );
      } catch (error) {
        return storageReadFailure(error, options?.signal);
      }
    });
  }

  getMetadata(key: string, options?: StorageCallOptions) {
    return observeFs('fs.s3.metadata', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      try {
        const response = await this.client.send(
          new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.getFullKey(key) }),
          { abortSignal: options?.signal },
        );
        if (
          response.ContentLength === undefined ||
          response.ContentType === undefined ||
          response.LastModified === undefined
        )
          return UnexpectedDefect({ cause: new Error('HEAD omitted required size, type or modification time') });
        return {
          key,
          size: response.ContentLength,
          contentType: response.ContentType,
          lastModified: response.LastModified,
          etag: response.ETag ?? '',
        };
      } catch (error) {
        return missing(error) ? null : storageReadFailure(error, options?.signal);
      }
    });
  }

  list(prefix: string, options?: StorageCallOptions) {
    return observeFs('fs.s3.list', async () => {
      if (options?.signal?.aborted) return StorageCancelled({ cause: options.signal.reason });
      try {
        const files: string[] = [];
        let token: string | undefined;
        do {
          const page = await this.client.send(
            new ListObjectsV2Command({
              Bucket: this.config.bucket,
              Prefix: this.getFullKey(prefix),
              ContinuationToken: token,
            }),
            { abortSignal: options?.signal },
          );
          for (const object of page.Contents ?? []) {
            if (object.Key !== undefined)
              files.push(this.config.prefix ? object.Key.slice(this.config.prefix.length + 1) : object.Key);
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && token === undefined)
            return UnexpectedDefect({ cause: new Error('S3 truncated a list without a continuation token') });
        } while (token !== undefined);
        return files;
      } catch (error) {
        return storageReadFailure(error, options?.signal);
      }
    });
  }

  private getFullKey(key: string): string {
    return this.config.prefix ? `${this.config.prefix}/${key}` : key;
  }
}

export function createS3StorageAdapter(config: S3StorageConfig) {
  return new S3StorageAdapter(config);
}
