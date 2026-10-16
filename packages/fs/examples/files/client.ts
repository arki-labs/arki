/**
 * The browser side: one call uploads and confirms. Types come from the
 * contract only (a type import), so no server code reaches the bundle.
 */
import type { ContractRouterClient } from '@orpc/contract';

import type { FileId } from '../../src/files/index.js';
import type { appContract } from './server.js';
import { uploadFile } from '../../src/files/index.js';

export type AppClient = ContractRouterClient<typeof appContract>;

// browser: createUpload → PUT → confirmUpload in one call; keep the FileId
export async function attach(orpc: AppClient, blob: Blob, onPercent: (percent: number) => void): Promise<FileId> {
  const file = await uploadFile(orpc.files, blob, {
    onProgress: (sent, total) => onPercent(total === 0 ? 100 : Math.round((sent / total) * 100)),
  });
  return file.id;
}
