/**
 * The browser half of the upload recipe: createUpload → PUT → confirmUpload.
 * Any client with the two methods works: the oRPC client of `filesContract`,
 * or a small fetch wrapper.
 */
import type { FileId, FileRecord, UploadRequest, UploadTicket } from './schemas.js';
import { FILE_ERROR_CODES, FileStorageError } from './errors.js';

/** The two calls `uploadFile` makes on the server. */
export type UploadClient = {
  createUpload(input: UploadRequest): Promise<UploadTicket>;
  confirmUpload(input: { fileId: FileId }): Promise<FileRecord>;
};

export type UploadFileOptions = {
  /** Upload progress in bytes. Uses `XMLHttpRequest` where it exists (fetch has no upload progress). */
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
};

/** The part of `XMLHttpRequest` this file uses. The DOM lib is not part of this package's types. */
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

function isXhrConstructor(value: unknown): value is XhrConstructor {
  return typeof value === 'function';
}

/** `Blob.type` without parameters (`text/plain;charset=utf-8` → `text/plain`); empty means bytes. */
function mimeOf(blob: Blob): string {
  const type = blob.type.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === '' ? 'application/octet-stream' : type;
}

async function putWithFetch(ticket: UploadTicket, blob: Blob, signal: AbortSignal | undefined): Promise<number> {
  const response = await fetch(ticket.url, { method: ticket.method, headers: ticket.headers, body: blob, signal });
  return response.status;
}

function putWithXhr(
  Request: XhrConstructor,
  ticket: UploadTicket,
  blob: Blob,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal | undefined,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new Request();
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const done = () => signal?.removeEventListener('abort', abort);
    xhr.open(ticket.method, ticket.url);
    for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener('progress', event => onProgress(event.loaded, event.total));
    xhr.addEventListener('load', () => {
      done();
      resolve(xhr.status);
    });
    xhr.addEventListener('error', () => {
      done();
      reject(new FileStorageError(FILE_ERROR_CODES.storage, 'upload PUT failed: network error'));
    });
    xhr.addEventListener('abort', () => {
      done();
      const reason: unknown = signal?.reason;
      reject(
        reason instanceof Error ? reason : new FileStorageError(FILE_ERROR_CODES.storage, 'upload PUT was aborted'),
      );
    });
    xhr.send(blob);
  });
}

/**
 * Uploads `blob` through the files table and returns the confirmed record.
 * Store `record.id` (a `FileId`), never a URL.
 *
 * @example
 * ```ts
 * const file = await uploadFile(orpc.files, input.files[0], { onProgress: (sent, total) => setPercent(sent / total) });
 * ```
 */
export async function uploadFile(
  client: UploadClient,
  blob: Blob,
  options: UploadFileOptions = {},
): Promise<FileRecord> {
  const { onProgress, signal } = options;
  signal?.throwIfAborted();
  const ticket = await client.createUpload({ mime: mimeOf(blob), size: blob.size });

  const Request: unknown = Reflect.get(globalThis, 'XMLHttpRequest');
  let status: number;
  if (onProgress && isXhrConstructor(Request)) {
    status = await putWithXhr(Request, ticket, blob, onProgress, signal);
  } else {
    status = await putWithFetch(ticket, blob, signal);
    // No XMLHttpRequest here (Node, Deno, workers): report the whole body once it is sent.
    onProgress?.(blob.size, blob.size);
  }
  if (status < 200 || status >= 300) {
    throw new FileStorageError(FILE_ERROR_CODES.storage, `upload PUT failed with HTTP ${String(status)}`);
  }
  return client.confirmUpload({ fileId: ticket.fileId });
}
