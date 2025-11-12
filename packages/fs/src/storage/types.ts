/**
 * Storage - Core Types
 *
 * Defines the interface for storage adapters and common types
 */

/**
 * Configuration for storage providers
 */
export type StorageConfig =
  | LocalStorageConfig
  | S3StorageConfig;

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
   * List files with a prefix
   */
  list(prefix: string): Promise<string[]>;
};
