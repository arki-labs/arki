/**
 * Storage - Core Types
 *
 * Defines the interface for storage adapters and common types
 */

/**
 * Configuration for storage providers
 */
export type StorageConfig = LocalStorageConfig | S3StorageConfig;

export type LocalStorageConfig = {
  provider: 'local';
  basePath: string;
  baseUrl: string;
};

export type S3StorageConfig = {
  provider: 's3';
  bucket: string;
  prefix?: string;
  region?: string;
  baseUrl: string;
  /**
   * Explicit endpoint for S3-compatible services (e.g. Cloudflare R2, MinIO).
   * Overrides the `AWS_ENDPOINT_URL` env var when provided.
   */
  endpoint?: string;
  /**
   * Explicit credentials. When omitted, the adapter falls back to the
   * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars. Presets such as
   * `createR2Storage` inject these so app code never touches the AWS env.
   */
  accessKeyId?: string;
  secretAccessKey?: string;
};

/**
 * Metadata about a stored file
 */
export type StoredFile = {
  key: string;
  size: number;
  url: string;
  contentType?: string;
  etag?: string;
};

/**
 * Options for storing a file
 */
export type StoreOptions = {
  contentType?: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
  /**
   * Object visibility. `public` maps to a public-read ACL on S3-compatible
   * providers; ignored by the local adapter. Defaults to the provider/bucket
   * default when omitted.
   */
  visibility?: 'public' | 'private';
};

/**
 * Full metadata about a stored object, as returned by {@link StorageAdapter.getMetadata}.
 */
export type StoredFileMetadata = {
  key: string;
  size: number;
  contentType: string;
  lastModified: Date;
  etag: string;
};

/**
 * Options for generating a presigned URL via {@link StorageAdapter.getSignedUrl}.
 */
export type SignedUrlOptions = {
  /** Expiry in seconds. Defaults to 3600 (1 hour). */
  expiresIn?: number;
  /** Whether the URL is for downloading (`get`, default) or uploading (`put`). */
  operation?: 'get' | 'put';
  /** `Content-Disposition` hint for downloads. */
  disposition?: 'inline' | 'attachment';
  /** Filename to suggest in the `Content-Disposition` header. */
  filename?: string;
};

/**
 * Storage adapter interface
 *
 * All storage providers must implement this interface
 */
export type StorageAdapter = {
  /**
   * Store a file
   */
  put(key: string, data: Buffer, options?: StoreOptions): Promise<StoredFile>;

  /**
   * Retrieve a file
   */
  get(key: string): Promise<Buffer | null>;

  /**
   * Delete a file
   */
  delete(key: string): Promise<void>;

  /**
   * Delete multiple files
   */
  deleteMany(keys: string[]): Promise<void>;

  /**
   * Check if a file exists
   */
  exists(key: string): Promise<boolean>;

  /**
   * Get public URL for a file
   */
  getUrl(key: string): string;

  /**
   * Generate a time-limited presigned URL for private access.
   *
   * For providers without signing support (e.g. local), this returns the
   * public {@link getUrl} value.
   */
  getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string>;

  /**
   * Get full metadata for a stored object, or `null` if it does not exist.
   */
  getMetadata(key: string): Promise<StoredFileMetadata | null>;

  /**
   * List files with a prefix
   */
  list(prefix: string): Promise<string[]>;
};
