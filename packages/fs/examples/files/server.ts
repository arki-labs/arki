/**
 * The files table wired into a server: ids, table, storage, router and the
 * sweep schedule. Typechecked with the package; the README's code blocks are
 * copied from here (checked by `src/readme.test.ts`).
 */
import { implement, ORPCError } from '@orpc/server';

import type { IdOf } from '@arki/contracts';
import type { Locker, ScheduleDef } from '@arki/schedule';
import { defineId } from '@arki/contracts';
import { isFailure } from '@arki/failure';
import { defineSchedule } from '@arki/schedule';

import type { FilesDb, FileStorage } from '../../src/pg/index.js';
import { filesContract, filesRouter } from '../../src/orpc.js';
import { filesTable, fileStorage } from '../../src/pg/index.js';
import { createR2Storage } from '../../src/storage/r2';

// model/ids.ts (browser-safe)
export const userId = defineId('usr_');
export type UserId = IdOf<typeof userId>;

// model/tables.ts (server): add `files` to the app schema, then `drizzle-kit generate`
export const files = filesTable({ owner: userId });

// infra (boot): built once, shared by every request
export type R2Env = {
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
};

export function buildStorage(db: FilesDb, env: R2Env) {
  const adapter = createR2Storage({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_NAME,
  });
  return fileStorage(db, adapter, {
    files,
    bucket: 'uploads',
    limits: { maxSize: 20_000_000, allowedMime: ['image/*', 'application/pdf'] },
  });
}

// contract + router: contract-first, the four procedures come ready-made
export const appContract = { files: filesContract };
export type AppContext = { userId: UserId | null };

export function buildRouter(storage: FileStorage<typeof files>) {
  const implementer = implement(appContract).$context<AppContext>();
  return implementer.router({
    files: filesRouter(implementer.files, {
      storage: () => storage,
      actor: context => {
        if (!context.userId) throw new ORPCError('UNAUTHORIZED');
        return context.userId;
      },
    }),
  });
}

// on read: store the FileId, never the URL
export async function avatarUrl(storage: FileStorage<typeof files>, viewer: UserId, avatar: `fil_${string}`) {
  const link = await storage.url(viewer, avatar, { disposition: 'inline' });
  if (isFailure(link)) return link; // FileUnavailable or FileWrongState: show the placeholder
  return { url: link.url, expiresAt: link.expiresAt };
}

// the sweep: loop while `more`, inside a time budget
export async function drain(storage: FileStorage<typeof files>, options: { batch?: number; budgetMs?: number } = {}) {
  const deadline = Date.now() + (options.budgetMs ?? 60_000);
  let removed = 0;
  let failed = 0;
  for (;;) {
    const result = await storage.cleanupOrphans({ batch: options.batch });
    removed += result.removed;
    failed += result.failed;
    if (!result.more || Date.now() >= deadline) return { removed, failed };
  }
}

// every 15 minutes, one replica at a time (`locks`: `createLocks(...)` from @arki/lock)
export function cleanupSchedule(storage: FileStorage<typeof files>, locks: Locker): ScheduleDef {
  const schedule = defineSchedule({ name: 'files.cleanup', every: '15m', handler: () => drain(storage) });
  return { ...schedule, lock: { key: 'files.cleanup', locks } };
}
