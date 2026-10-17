/**
 * The expected outcomes of the files lifecycle, each defined once. The storage
 * calls return them (never throw them), the oRPC contract lists them
 * (`errorMap`), and a browser can revive them from a caught RPC error.
 * Faults stay thrown as a {@link FileStorageError}: bad input or config, the
 * local adapter, the object store failing. Browser-safe.
 */
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import { fileId } from './schemas.js';

/**
 * The file is missing, belongs to another bucket binding, or the policy denied
 * the call. One failure for all three on purpose, so a caller cannot probe which
 * files exist; the debug log says which it was. `fileId` is the id the caller
 * asked for, and is absent when the policy refused a new upload.
 */
export const FileUnavailable = defineFailure('fs.file_unavailable', {
  status: 404,
  data: z.object({ fileId: fileId.schema.optional() }),
  message: 'file unavailable',
  remediation: 'Check the file id and that this user may use the file.',
});

/** Confirm came before the PUT finished. The row stays pending, so confirming again later is fine. */
export const UploadPending = defineFailure('fs.upload_pending', {
  status: 409,
  data: z.object({ fileId: fileId.schema }),
  message: 'the upload of {fileId} has not finished',
  remediation: 'Finish the PUT to the ticket URL, then confirm again.',
});

/**
 * The file is not in the state the call needs: a URL for a file that is not
 * ready, a confirm on a file being deleted, or a confirm after the window passed.
 * The debug log says which.
 */
export const FileWrongState = defineFailure('fs.file_wrong_state', {
  status: 409,
  data: z.object({ fileId: fileId.schema }),
  message: 'file {fileId} is not in the right state for this call',
  remediation: 'Confirm a pending upload before you ask for its URL; a deleted or expired upload needs a new upload.',
});

/** The stored size, type or hash differs from the upload request. The row is now deleting. */
export const UploadMismatch = defineFailure('fs.upload_mismatch', {
  status: 422,
  data: z.object({ fileId: fileId.schema, reason: z.string() }),
  message: 'the stored object does not match the upload of {fileId}: {reason}',
  remediation: 'Upload the file again, with the size and type the upload request declared.',
});
