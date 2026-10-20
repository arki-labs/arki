// Cross-runtime smoke test for the portable entry `@arki/fs/files`. `test:runtimes`
// compiles src/files to .cache/files-dist (tsconfig.runtimes.json), then runs this
// under Node, Bun and Deno, and bundles it for the browser and Hermes.
// The adapter entries (/pg, /orpc, /testing) and the Node-only storage entries are not
// exercised here; their unit tests cover them.

import { RandomSourceUnavailable } from '@arki/contracts';

import {
  FILE_ERROR_CODES,
  fileId,
  FileStorageError,
  isFileStorageError,
  UploadPending,
  uploadRequest,
  uploadTicket,
} from '../.cache/files-dist/index.js';

const check = (name, ok) => {
  if (!ok) throw new Error(`smoke check failed: ${name}`);
};

const created = fileId.create();
let id;
if (typeof globalThis.crypto?.getRandomValues === 'function') {
  check('fileId.create makes a fil_ id', typeof created === 'string' && /^fil_[a-z][a-z0-9]{23}$/.test(created));
  id = created;
} else {
  check('missing entropy returns the declared refusal', RandomSourceUnavailable.is(created));
  // Engines without Web Crypto still validate stored IDs and exchange upload contracts.
  id = 'fil_abcdefghijklmnopqrstuvwx';
}
check('fileId recognizes a stored ID', fileId.is(id));

const ticket = uploadTicket.parse({
  fileId: id,
  url: 'https://store.example.com/files/x?X-Amz-Signature=s',
  method: 'PUT',
  headers: { 'Content-Type': 'image/png', 'If-None-Match': '*' },
  expiresAt: '2026-10-16T10:05:00.000Z',
});
check('a ticket parses', ticket.fileId === id);
check(
  'a mime with parameters is refused',
  !uploadRequest.safeParse({ mime: 'text/plain; charset=utf-8', size: 1 }).success,
);

const error = new FileStorageError(FILE_ERROR_CODES.storage, 'store down');
check('errors carry a stable code', isFileStorageError(error) && error.code === 'ARKI_FS_E007' && error.retryable);

const pending = UploadPending({ fileId: id });
check(
  'failures are values with a dotted code',
  UploadPending.is(pending) && pending.code === 'fs.upload_pending' && pending.status === 409,
);

console.log('smoke checks passed');
