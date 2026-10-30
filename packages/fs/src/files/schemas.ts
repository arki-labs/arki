/**
 * The wire shapes of the files table, written once. Types are inferred from
 * these schemas, except `UploadRequest` (`./types.ts`), which an exact type test
 * locks to its schema. Browser-safe: no Drizzle, no Node APIs.
 */
import { z } from 'zod';

import { fileId } from './types.js';

/** The file states, in lifecycle order. The table's `status` column takes the same tuple. */
export const FILE_STATUSES = ['pending', 'ready', 'deleting'] as const;

/** `pending` until the server saw the object; `ready` after; `deleting` until the sweep removes row and object. */
export const fileStatus = z.enum(FILE_STATUSES);
export type FileStatus = z.infer<typeof fileStatus>;

/** A plain `type/subtype`. No parameters, no control characters. */
export const mimeSchema = z
  .string()
  .max(255)
  .regex(/^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/i);

/** What a client asks for before it uploads. */
export const uploadRequest = z.strictObject({
  mime: mimeSchema,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** A signed, create-only PUT grant. Send `headers` unchanged. */
export const uploadTicket = z.strictObject({
  fileId: fileId.schema,
  url: z.url(),
  method: z.literal('PUT'),
  /** `Content-Type` and `If-None-Match`. Both are signed. */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});

/** What clients see of a file. No bucket, key, owner or etag. */
export const fileRecord = z.strictObject({
  id: fileId.schema,
  mime: mimeSchema,
  size: uploadRequest.shape.size,
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  status: fileStatus,
  createdAt: z.iso.datetime(),
});

/** What `cleanupOrphans` accepts: how many due rows one sweep claims. */
export const cleanupOptions = z.strictObject({ batch: z.number().int().min(1).max(1000).default(100) });

/** A GET URL and the moment it stops working, so screens can refresh before then. */
export const signedFileUrl = z.strictObject({ url: z.url(), expiresAt: z.iso.datetime() });

export type UploadTicket = z.infer<typeof uploadTicket>;
export type FileRecord = z.infer<typeof fileRecord>;
export type SignedFileUrl = z.infer<typeof signedFileUrl>;
