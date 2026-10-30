import type { z } from 'zod';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { toFileRecord } from '../lifecycle/record.js';
import type { FileId, FileRecord, UploadRequest, UploadTicket } from './index.js';
import { StorageCancelled, StorageRejected, StorageWriteUncertain } from '../storage/failures.js';
import {
  FILE_ERROR_CODES,
  fileId,
  FileStorageError,
  isFileStorageError,
  uploadFile,
  uploadRequest,
  uploadTicket,
} from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fileId', () => {
  it('is written once, as the fil_ prefix', () => {
    expectTypeOf<FileId>().toEqualTypeOf<`fil_${string}`>();
    expect(orThrow(fileId.create())).toMatch(/^fil_[a-z][a-z0-9]{23}$/);
  });
});

describe('uploadRequest', () => {
  it('takes zero bytes and the largest safe size', () => {
    expect(uploadRequest.safeParse({ mime: 'image/png', size: 0 }).success).toBe(true);
    expect(uploadRequest.safeParse({ mime: 'image/png', size: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  });

  it('refuses sizes a bigint column or a client could get wrong', () => {
    for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(uploadRequest.safeParse({ mime: 'image/png', size }).success).toBe(false);
    }
  });

  // The mime is signed into a header; parameters or control characters could smuggle header text.
  it('refuses mime types with parameters, spaces or control characters', () => {
    for (const mime of ['text/plain; charset=utf-8', 'image/png\r\nX-Evil: 1', 'image', '/png', 'image/ png']) {
      expect(uploadRequest.safeParse({ mime, size: 1 }).success).toBe(false);
    }
  });

  it('refuses extra fields: a client never picks the key', () => {
    expect(uploadRequest.safeParse({ mime: 'image/png', size: 1, key: 'other/owner/file' }).success).toBe(false);
  });
});

describe('FileStorageError', () => {
  it('marks only "retry later" codes retryable', () => {
    const retryable = Object.values(FILE_ERROR_CODES).filter(code => new FileStorageError(code, 'x').retryable);
    expect(retryable).toEqual([FILE_ERROR_CODES.storage]);
  });

  it('is recognised by isFileStorageError, plain errors are not', () => {
    expect(isFileStorageError(new FileStorageError(FILE_ERROR_CODES.invalid, 'x'))).toBe(true);
    expect(isFileStorageError(new Error('x'))).toBe(false);
  });
});

function fakeClient(confirmed: FileRecord) {
  const ticket: UploadTicket = {
    fileId: confirmed.id,
    url: 'https://store.example.com/files/x?X-Amz-Signature=s',
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', 'If-None-Match': '*' },
    expiresAt: '2026-10-16T10:05:00.000Z',
  };
  const createUpload = vi.fn((_input: UploadRequest) => Promise.resolve(ticket));
  const confirmUpload = vi.fn((_input: { fileId: FileId }) => Promise.resolve(confirmed));
  return { ticket, client: { createUpload, confirmUpload } };
}

const record: FileRecord = {
  id: orThrow(fileId.create()),
  mime: 'text/plain',
  size: 5,
  sha256: null,
  status: 'ready',
  createdAt: '2026-10-16T10:00:00.000Z',
};

describe('uploadFile', () => {
  it('asks for a ticket, PUTs with the ticket headers unchanged, then confirms', async () => {
    const { ticket, client } = fakeClient(record);
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadFile(client, new Blob(['hello'], { type: 'text/plain;charset=utf-8' }));

    expect(client.createUpload).toHaveBeenCalledWith({ mime: 'text/plain', size: 5 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(ticket.url);
    expect(init).toMatchObject({ method: 'PUT', headers: ticket.headers });
    expect(client.confirmUpload).toHaveBeenCalledWith({ fileId: record.id });
    expect(result).toBe(record);
  });

  it('sends an untyped blob as application/octet-stream', async () => {
    const { client } = fakeClient(record);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 200 })));
    orThrow(await uploadFile(client, new Blob(['hello'])));
    expect(client.createUpload).toHaveBeenCalledWith({ mime: 'application/octet-stream', size: 5 });
  });

  // Client success is never proof: a refused PUT must not reach confirm.
  it('does not confirm when the store refuses the PUT', async () => {
    const { client } = fakeClient(record);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('SignatureDoesNotMatch', { status: 403 })));
    const error: unknown = await uploadFile(client, new Blob(['hello'])).catch((error_: unknown) => error_);
    expect(StorageRejected.is(error)).toBe(true);
    expect(client.confirmUpload).not.toHaveBeenCalled();
  });

  it('reports upload progress through XMLHttpRequest when it exists', async () => {
    const { ticket, client } = fakeClient(record);
    const sentHeaders: Record<string, string> = {};
    class FakeXhr {
      status = 0;
      private progress?: (event: { loaded: number; total: number }) => void;
      private readonly listeners = new Map<string, () => void>();
      readonly upload = {
        addEventListener: (_type: 'progress', listener: (event: { loaded: number; total: number }) => void) => {
          this.progress = listener;
        },
      };
      addEventListener(type: string, listener: () => void) {
        this.listeners.set(type, listener);
      }
      open(method: string, url: string) {
        expect([method, url]).toEqual(['PUT', ticket.url]);
      }
      setRequestHeader(name: string, value: string) {
        sentHeaders[name] = value;
      }
      send(body: Blob) {
        this.progress?.({ loaded: 2, total: body.size });
        this.progress?.({ loaded: body.size, total: body.size });
        this.status = 200;
        this.listeners.get('load')?.();
      }
      abort() {
        this.listeners.get('abort')?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const progress: number[] = [];

    orThrow(
      await uploadFile(client, new Blob(['hello'], { type: 'text/plain' }), {
        onProgress: sent => progress.push(sent),
      }),
    );

    expect(progress).toEqual([2, 5]);
    expect(sentHeaders).toEqual(ticket.headers);
    expect(client.confirmUpload).toHaveBeenCalledOnce();
  });

  it('stops before asking for a ticket when the signal is already aborted', async () => {
    const { client } = fakeClient(record);
    expect(StorageCancelled.is(await uploadFile(client, new Blob(['x']), { signal: AbortSignal.abort() }))).toBe(true);
    expect(client.createUpload).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'xhr'] as const)(
    'does not send or confirm after cancellation while creating a ticket: %s',
    async mode => {
      const { client, ticket } = fakeClient(record);
      const controller = new AbortController();
      client.createUpload.mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve(ticket);
      });
      const Request = vi.fn();
      if (mode === 'xhr') vi.stubGlobal('XMLHttpRequest', Request);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      expect(
        StorageCancelled.is(
          await uploadFile(client, new Blob(['x']), {
            signal: controller.signal,
            onProgress() {
              /* no UI observer */
            },
          }),
        ),
      ).toBe(true);
      expect(Request).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(client.confirmUpload).not.toHaveBeenCalled();
    },
  );

  it('preserves uncertainty when cancellation interrupts a dispatched XHR PUT', async () => {
    const { client } = fakeClient(record);
    const controller = new AbortController();
    class InterruptedXhr {
      status = 200;
      listeners = new Map<string, () => void>();
      upload = {
        addEventListener() {
          /* no progress in this fixture */
        },
      };
      open() {
        /* fixture */
      }
      setRequestHeader() {
        /* fixture */
      }
      addEventListener(name: string, listener: () => void) {
        this.listeners.set(name, listener);
      }
      abort() {
        this.listeners.get('abort')?.();
      }
      send() {
        controller.abort();
        this.listeners.get('load')?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', InterruptedXhr);
    const outcome = await uploadFile(client, new Blob(['x']), {
      signal: controller.signal,
      onProgress() {
        /* no UI observer */
      },
    });
    expect(StorageWriteUncertain.is(outcome)).toBe(true);
    expect(client.confirmUpload).not.toHaveBeenCalled();
  });

  it('supervises a progress callback fault and never starts confirm after that fault', async () => {
    const { client } = fakeClient(record);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 200 })));
    const cause = new Error('progress renderer defect');
    const outcome = await uploadFile(client, new Blob(['x']), {
      onProgress() {
        throw cause;
      },
    });
    expect(UnexpectedDefect.is(outcome)).toBe(true);
    expect(outcome).toMatchObject({ cause });
    expect(client.confirmUpload).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'xhr'] as const)(
    'owns a rejected asynchronous progress callback before confirm: %s',
    async mode => {
      const { client } = fakeClient(record);
      const error = new Error('async progress defect');
      if (mode === 'fetch') vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 200 })));
      else {
        class ProgressXhr {
          status = 200;
          listeners = new Map<string, () => void>();
          report?: () => void;
          upload = {
            addEventListener: (_name: string, callback: (event: { loaded: number; total: number }) => void) => {
              this.report = () => callback({ loaded: 1, total: 1 });
            },
          };
          open() {
            /* fixture */
          }
          setRequestHeader() {
            /* fixture */
          }
          addEventListener(name: string, callback: () => void) {
            this.listeners.set(name, callback);
          }
          abort() {
            this.listeners.get('abort')?.();
          }
          send() {
            this.report?.();
            this.listeners.get('load')?.();
          }
        }
        vi.stubGlobal('XMLHttpRequest', ProgressXhr);
      }
      const outcome = await uploadFile(client, new Blob(['x']), { onProgress: () => Promise.reject(error) });
      expect(UnexpectedDefect.is(outcome)).toBe(true);
      expect(outcome).toMatchObject({ cause: error });
      expect(client.confirmUpload).not.toHaveBeenCalled();
    },
  );

  it('parses as a ticket the server would send', () => {
    expect(uploadTicket.safeParse(fakeClient(record).ticket).success).toBe(true);
  });
});

describe('types that server declarations print without Zod', () => {
  it('lock the plain upload request to its schema in both directions', () => {
    expectTypeOf<z.input<typeof uploadRequest>>().toEqualTypeOf<UploadRequest>();
    expectTypeOf<z.output<typeof uploadRequest>>().toEqualTypeOf<UploadRequest>();
  });

  it('keep the row mapper exactly on the client record', () => {
    expectTypeOf<ReturnType<typeof toFileRecord>>().toEqualTypeOf<FileRecord>();
  });
});
