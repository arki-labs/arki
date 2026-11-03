/**
 * Storage - Factory
 *
 * Creates storage instances based on configuration
 */

import { unreachable } from '@arki/failure';

import type { StorageConfig } from './types.js';
import { createLocalStorageAdapter } from './local-adapter.js';
import { createS3StorageAdapter } from './s3-adapter.js';

export { createLocalStorageAdapter } from './local-adapter.js';
export { createS3StorageAdapter } from './s3-adapter.js';
export { createR2Storage } from './r2.js';
export type { R2StorageConfig } from './r2.js';
export type * from './types.js';
export * from './failures.js';

/**
 * Create a storage instance based on the provided configuration
 *
 * Automatically selects the appropriate adapter (local or S3) based on
 * the provider specified in the config.
 *
 * @example
 * ```ts
 * // Local storage
 * const storage = createStorage({
 *   provider: 'local',
 *   basePath: '/var/data/uploads',
 *   baseUrl: 'https://cdn.example.com/uploads'
 * });
 *
 * // S3 storage
 * const storage = createStorage({
 *   provider: 's3',
 *   bucket: 'my-bucket',
 *   prefix: 'uploads',
 *   baseUrl: 'https://cdn.example.com'
 * });
 * ```
 */
export function createStorage(config: StorageConfig) {
  switch (config.provider) {
    case 'local': {
      return createLocalStorageAdapter(config);
    }
    case 's3': {
      return createS3StorageAdapter(config);
    }
    default: {
      return unreachable(config);
    }
  }
}
