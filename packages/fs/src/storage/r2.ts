/**
 * Storage - Cloudflare R2 Preset
 *
 * Thin preset over the S3 adapter that wires Cloudflare R2's endpoint and
 * `auto` region from an account ID + credentials. Apps pass their own
 * `R2_*` env values here and never import `@aws-sdk` or construct an
 * `S3Client` directly.
 */

import { createS3StorageAdapter } from './s3-adapter';

export type R2StorageConfig = {
  /** Cloudflare account ID — used to derive the R2 endpoint. */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Public base URL for objects (e.g. a custom domain or `*.r2.dev`).
   * Falls back to the S3 API host, which is not publicly reachable — set
   * this whenever objects must be served publicly.
   */
  publicUrl?: string;
  /** Optional key prefix applied to every object. */
  prefix?: string;
};

/**
 * Create a signed-upload adapter backed by Cloudflare R2.
 *
 * @example
 * ```ts
 * const storage = createR2Storage({
 *   accountId: env.R2_ACCOUNT_ID,
 *   accessKeyId: env.R2_ACCESS_KEY_ID,
 *   secretAccessKey: env.R2_SECRET_ACCESS_KEY,
 *   bucket: env.R2_BUCKET_NAME,
 *   publicUrl: env.R2_PUBLIC_URL,
 * });
 * await storage.put('characters/abc/ref.png', buffer, { contentType: 'image/png' });
 * const url = await storage.getSignedUrl('characters/abc/ref.png', { expiresIn: 600 });
 * ```
 */
export function createR2Storage(config: R2StorageConfig) {
  return createS3StorageAdapter({
    provider: 's3',
    bucket: config.bucket,
    prefix: config.prefix,
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    baseUrl: config.publicUrl ?? `https://${config.bucket}.r2.cloudflarestorage.com`,
  });
}
