/** The owned browser upload workflow accepts values or canonical failures at each RPC phase. */
import { z } from 'zod';

import type { FailureOf } from '@arki/failure';
import { isFailure, UnexpectedDefect } from '@arki/failure';
import { parse } from '@arki/schema';

import type { CONFIRM_UPLOAD_FAILURES, CREATE_UPLOAD_FAILURES } from './failures.js';
import type { FileId, FileRecord, UploadRequest, UploadTicket } from './schemas.js';
import { StorageCancelled, StorageRejected, StorageWriteUncertain } from '../storage/failures.js';
import { executeFs, storageWriteFailure } from '../storage/operation.js';
import { uploadTicket } from './schemas.js';

export type UploadClient = {
  createUpload(input: UploadRequest): Promise<UploadTicket | FailureOf<(typeof CREATE_UPLOAD_FAILURES)[number]>>;
  confirmUpload(input: { fileId: FileId }): Promise<FileRecord | FailureOf<(typeof CONFIRM_UPLOAD_FAILURES)[number]>>;
};
export type UploadFileOptions = {
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
};

type Xhr = {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  readonly upload: {
    addEventListener(type: 'progress', listener: (event: { loaded: number; total: number }) => void): void;
  };
  addEventListener(type: 'load' | 'error' | 'abort', listener: () => void): void;
};
type XhrConstructor = new () => Xhr;
const xhrConstructor = z.custom<XhrConstructor>(value => typeof value === 'function');
const _XHR_FAILURES = [StorageCancelled, StorageWriteUncertain, UnexpectedDefect] as const;
type XhrFailure = FailureOf<(typeof _XHR_FAILURES)[number]>;

function putWithXhr(
  Request: XhrConstructor,
  ticket: UploadTicket,
  blob: Blob,
  onProgress: NonNullable<UploadFileOptions['onProgress']>,
  signal?: AbortSignal,
) {
  return new Promise<number | XhrFailure>(resolve => {
    if (signal?.aborted) {
      resolve(StorageCancelled({ cause: signal.reason }));
      return;
    }
    const xhr = new Request();
    let settled = false;
    let dispatched = false;
    let progress = Promise.resolve();
    const done = (outcome: number | XhrFailure) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(outcome);
    };
    const abort = () => {
      done(dispatched ? StorageWriteUncertain({ cause: signal?.reason }) : StorageCancelled({ cause: signal?.reason }));
      try {
        xhr.abort();
      } catch {
        /* Cleanup cannot replace the terminal outcome. */
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      xhr.open(ticket.method, ticket.url);
      for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);
      xhr.upload.addEventListener('progress', event => {
        if (settled) return;
        // A void callback may still return a promise. Load waits for its reports before confirming.
        progress = progress
          .then(() => (settled ? undefined : onProgress(event.loaded, event.total)))
          .catch((error: unknown) => {
            done(UnexpectedDefect({ cause: error }));
            try {
              xhr.abort();
            } catch {
              /* Cleanup cannot replace the observer fault. */
            }
          });
      });
      xhr.addEventListener('load', () => {
        void progress.then(() => done(xhr.status)).catch((error: unknown) => done(UnexpectedDefect({ cause: error })));
      });
      xhr.addEventListener('error', () => done(StorageWriteUncertain()));
      xhr.addEventListener('abort', () =>
        done(
          dispatched ? StorageWriteUncertain({ cause: signal?.reason }) : StorageCancelled({ cause: signal?.reason }),
        ),
      );
      if (signal?.aborted) {
        abort();
        return;
      }
      dispatched = true;
      xhr.send(blob);
    } catch (error) {
      done(dispatched ? StorageWriteUncertain({ cause: error }) : UnexpectedDefect({ cause: error }));
    }
  });
}

export function uploadFile(client: UploadClient, blob: Blob, options: UploadFileOptions = {}) {
  return executeFs('fs.upload', async () => {
    const { signal, onProgress } = options;
    if (signal?.aborted) return StorageCancelled({ cause: signal.reason });
    const mime = blob.type.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
    const created = await client.createUpload({ mime, size: blob.size });
    if (isFailure(created)) return created;
    const ticket = parse(uploadTicket, created);
    if (isFailure(ticket)) return ticket;
    if (signal?.aborted) return StorageCancelled({ cause: signal.reason });
    const Request = xhrConstructor.safeParse(Reflect.get(globalThis, 'XMLHttpRequest'));
    let status;
    if (onProgress && Request.success) status = await putWithXhr(Request.data, ticket, blob, onProgress, signal);
    else {
      try {
        const response = await fetch(ticket.url, {
          method: ticket.method,
          headers: ticket.headers,
          body: blob,
          signal,
        });
        status = response.status;
      } catch (error) {
        return storageWriteFailure(error);
      }
      await onProgress?.(blob.size, blob.size);
    }
    if (isFailure(status)) return status;
    if (status < 200 || status >= 300)
      return status >= 400 && status < 500 ? StorageRejected() : StorageWriteUncertain();
    // PUT acknowledgement is known, but cancellation must never initiate a new confirm mutation.
    if (signal?.aborted) return StorageCancelled({ cause: signal.reason });
    return client.confirmUpload({ fileId: ticket.fileId });
  });
}
