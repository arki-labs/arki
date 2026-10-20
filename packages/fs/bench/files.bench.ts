// Speed of @arki/fs signed uploads and the files-table lifecycle.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// There is no in-process files-table library to rank against. So the signer is
// compared with a direct @aws-sdk/s3-request-presigner call (the cost of the
// wrapper), and the lifecycle is shown next to the raw Drizzle statements it
// replaces, as a scenario: the two do different work and are never ranked.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations, eq, sql } from 'drizzle-orm';

import { compare, defineSuite, scenario } from '@arki/bench';
import { defineId } from '@arki/contracts';
import { initDbRuntimeLocal } from '@arki/db/runtime-local';
import { orThrow } from '@arki/failure';

import { filesTable, fileStorage } from '../src/pg/index.js';
import { createS3StorageAdapter } from '../src/storage/s3-adapter';
import { memoryUploadAdapter } from '../src/testing.js';

const ENDPOINT = 'https://acct123.r2.cloudflarestorage.com';
const CREDENTIALS = { accessKeyId: 'AKIA_BENCH', secretAccessKey: 'secret_bench' };
const SIGNED = 'content-length;content-type;host;if-none-match';

type Upload = { key: string; mime: string; size: number };
const uploads: readonly Upload[] = [
  { key: 'files/fil_a1b2c3d4e5f6g7h8i9j0k1l2', mime: 'image/png', size: 0 },
  { key: 'files/fil_m3n4o5p6q7r8s9t0u1v2w3x4', mime: 'application/pdf', size: 20_000_000 },
  { key: 'files/fil_y5z6a7b8c9d0e1f2g3h4i5j6', mime: 'text/plain', size: 1 },
];

/** What every signer must produce for an upload: the key's path, the three signed headers, 300 s, no body checksum. */
function shape(url: string) {
  const parsed = new URL(url);
  const names = [...parsed.searchParams.keys()].map(name => name.toLowerCase());
  return {
    path: parsed.pathname,
    signedHeaders: parsed.searchParams.get('X-Amz-SignedHeaders'),
    expires: parsed.searchParams.get('X-Amz-Expires'),
    checksum: names.some(name => name.includes('checksum')),
  };
}

const arkiSigner = createS3StorageAdapter({
  provider: 's3',
  bucket: 'uploads',
  region: 'auto',
  endpoint: ENDPOINT,
  ...CREDENTIALS,
  baseUrl: ENDPOINT,
});
const sdkClient = new S3Client({
  region: 'auto',
  endpoint: ENDPOINT,
  credentials: CREDENTIALS,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

// The lifecycle runs on in-memory PGlite with the memory store: it measures the library, not a network.
const userId = defineId('usr_');
const files = filesTable({ owner: userId });
const local = await orThrow(initDbRuntimeLocal({ memory: true }, { relations: defineRelations({ files }) }));
const push = await pushSchema({ files }, local.db);
await push.apply();
const store = memoryUploadAdapter();
const storage = fileStorage(local.db, store, {
  files,
  bucket: 'uploads',
  limits: { maxSize: 1000, allowedMime: ['*/*'] },
});
const owner = userId.create();
const body = new TextEncoder().encode('hello');

export default defineSuite({
  id: '@arki/fs',
  intro:
    'Speed of the `@arki/fs` files table: signing a create-only upload URL, and one upload through the whole lifecycle. No in-process files-table library exists to rank against, so the signer is compared with the AWS SDK presigner it wraps, and the lifecycle is shown next to the raw statements it replaces.',
  notes: [
    'Both signers sign the same three headers (Content-Type, Content-Length, If-None-Match) with the same credentials and add no body checksum; the gap is the cost of the wrapper.',
    'The lifecycle rows run on in-memory PGlite with the memory store, so they show library and SQL cost only. A real upload is dominated by the network and the object store.',
    '`createUpload + confirmUpload` also signs a URL, reads the object metadata and checks size and type; the raw row skips all of that. It is a scenario, not a ranking.',
  ],
  groups: [
    compare<Upload>({
      id: 'sign-put',
      title: 'Sign a create-only PUT URL',
      contract: {
        id: 'fs-sign-put/v1',
        description:
          'a 300 s PUT URL for the key signing content-length, content-type, host and if-none-match, with no body checksum',
      },
      inputs: uploads,
      expected: upload => ({ path: `/${upload.key}`, signedHeaders: SIGNED, expires: '300', checksum: false }),
      baseline: 'arki',
      mode: 'async',
      cases: c => ({
        arki: c({
          label: '@arki/fs getSignedUrl (put)',
          package: '@arki/fs',
          run: upload =>
            arkiSigner.getSignedUrl(upload.key, {
              operation: 'put',
              expiresIn: 300,
              contentType: upload.mime,
              contentLength: upload.size,
              ifNoneMatch: '*',
            }),
          normalize: shape,
        }),
        sdk: c({
          label: '@aws-sdk/s3-request-presigner',
          package: '@aws-sdk/s3-request-presigner',
          run: upload =>
            getSignedUrl(
              sdkClient,
              new PutObjectCommand({
                Bucket: 'uploads',
                Key: upload.key,
                ContentType: upload.mime,
                ContentLength: upload.size,
                IfNoneMatch: '*',
              }),
              { expiresIn: 300, signableHeaders: new Set(['content-type']) },
            ),
          normalize: shape,
        }),
      }),
    }),
    scenario({
      id: 'lifecycle',
      title: 'One upload, row first (PGlite, memory store)',
      mode: 'async',
      note: 'Different work per row: not ranked.',
      cases: c => ({
        arki: c({
          label: '@arki/fs createUpload + PUT + confirmUpload',
          package: '@arki/fs',
          run: async () => {
            const ticket = await storage.createUpload(owner, { mime: 'text/plain', size: body.byteLength });
            await store.browserPut(ticket.url, body, ticket.headers);
            return storage.confirmUpload(owner, ticket.fileId);
          },
        }),
        raw: c({
          label: 'raw Drizzle insert + update',
          package: 'drizzle-orm',
          run: async () => {
            const [row] = await local.db
              .insert(files)
              .values({
                ownerId: owner,
                bucket: 'raw',
                key: `raw/${crypto.randomUUID()}`,
                mime: 'text/plain',
                size: body.byteLength,
                expiresAt: sql`now() + interval '5 minutes'`,
                cleanupAt: sql`now() + interval '20 minutes'`,
              })
              .returning({ id: files.id });
            if (!row) throw new Error('insert returned no row');
            return local.db
              .update(files)
              .set({ status: 'ready', confirmedAt: sql`now()`, cleanupAt: null })
              .where(eq(files.id, row.id))
              .returning();
          },
        }),
      }),
    }),
  ],
});
