// Cross-runtime smoke test for the portable entry `@arki/fs/files`. `test:runtimes`
// compiles src/files to .cache/files-dist (tsconfig.runtimes.json), then runs this
// under Node, Bun and Deno, and bundles it for the browser and Hermes.
// The adapter entries (/pg, /orpc, /testing) and the Node-only storage entries are not
// exercised here; their unit tests cover them.

import {
  FILE_ERROR_CODES,
  fileId,
  FileStorageError,
  isFileStorageError,
  uploadRequest,
  uploadTicket,
} from '../.cache/files-dist/index.js';

const check = (name, ok) => {
  if (!ok) throw new Error(`smoke check failed: ${name}`);
};

const id = fileId.create();
check('fileId.create makes a fil_ id', /^fil_[a-z][a-z0-9]{23}$/.test(id) && fileId.is(id));

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

const error = new FileStorageError(FILE_ERROR_CODES.objectMissing, 'not uploaded yet');
check('errors carry a stable code', isFileStorageError(error) && error.code === 'ARKI_FS_E004' && error.retryable);

console.log('smoke checks passed');
