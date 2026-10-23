# @arki/fs

File storage for arki apps: storage adapters (S3, Cloudflare R2, local disk), local file helpers, and
the **files table**: a Postgres-backed upload recipe where the database knows every object before
any byte is written.

## Install and peers

`@arki/fs` is a workspace package (`"private": true`). Add it with `bun add @arki/fs` in the app.

| Entry                                                       | What                                                        | Runs on                                        | Peers you install                |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- | -------------------------------- |
| `@arki/fs/files`                                            | file ids, wire schemas, failures, error codes, `uploadFile` | Node, Bun, Deno, browsers, Hermes              | none                             |
| `@arki/fs/pg`                                               | `filesTable`, `fileStorage`, the sweep on Postgres          | server                                         | `@arki/db`, `drizzle-orm`        |
| `@arki/fs/sqlite`                                           | the same on SQLite (libSQL); see [SQLite](#sqlite)          | server                                         | `@arki/db`, `drizzle-orm`        |
| `@arki/fs/orpc`                                             | `filesContract`, `filesRouter`                              | server; the contract gives clients their types | `@orpc/contract`, `@orpc/server` |
| `@arki/fs/testing`                                          | `memoryUploadAdapter`                                       | Node, Bun                                      | none                             |
| `@arki/fs/storage`, `/storage/*`, `/s3`, `/local/*`, `/env` | storage adapters and local helpers                          | Node, Bun                                      | none                             |

## Storage adapters

`@arki/fs/storage` exports `createStorage`, `createS3StorageAdapter`, `createR2Storage` and
`createLocalStorageAdapter`. Every adapter implements `StorageAdapter`: `put`, `get`, `delete`, `deleteMany`, `exists`, `getUrl`,
`getSignedUrl`, `getMetadata`, `list`. The S3 and R2 adapters return `SignedUploadAdapter`: their
`put` URLs sign `contentType`, `contentLength` and `ifNoneMatch: '*'`, so the store rejects an upload
that differs. The local adapter returns a plain `StorageAdapter`; its "signed" URL is the public URL.

Do not use `exists()` to decide that an object is missing: it answers `false` on any error.

## Files table

The flow is `createUpload → PUT → confirmUpload → url → remove`. Two rules decide the design. The
server derives every key from the row; the client never picks one. Nothing is `ready` until the
server has looked at the stored object.

Declare the owner id and the table:

```ts
// model/ids.ts (browser-safe)
export const userId = defineId('usr_');
export type UserId = IdOf<typeof userId>;

// model/tables.ts (server): add `files` to the app schema, then `drizzle-kit generate`
export const files = filesTable(pgColumns(), { owner: userId });
```

Build the storage once at boot (in a Dot feature, inside its `.infra()` step):

```ts
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
```

Add the four procedures, contract-first:

```ts
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
```

Upload from the browser in one call:

```ts
// browser: createUpload → PUT → confirmUpload in one call; keep the FileId
export async function attach(orpc: AppClient, blob: Blob, onPercent: (percent: number) => void): Promise<FileId> {
  const file = await uploadFile(orpc.files, blob, {
    onProgress: (sent, total) => onPercent(total === 0 ? 100 : Math.round((sent / total) * 100)),
  });
  return file.id;
}
```

With TanStack Query: `useMutation({ mutationFn: (blob: Blob) => uploadFile(orpc.files, blob) })`.
Keep upload and download URLs out of persisted query caches, logs and analytics.

Read it back. Store the `FileId`, never a URL:

```ts
// on read: store the FileId, never the URL
export async function avatarUrl(storage: FileStorage<typeof files>, viewer: UserId, avatar: `fil_${string}`) {
  const link = await storage.url(viewer, avatar, { disposition: 'inline' });
  if (isFailure(link)) return link; // FileUnavailable or FileWrongState: show the placeholder
  return { url: link.url, expiresAt: link.expiresAt };
}
```

`storage.remove(actor, fileId)` deletes it. Every call takes the acting owner id. The default policy
lets only the owner read and remove; pass `policy: { canCreate, canRead, canRemove }` to change that.

### The table

The app owns the migration, as with `journalTables`: add `files` to the schema and run
`drizzle-kit generate`. The library never runs DDL. For a hand-written migration:

```sql
create table files (
  id               varchar(256) primary key,             -- fil_ + 24 chars
  owner_id         varchar(256) not null,                -- the app's owner id kind
  bucket           text not null,                        -- binding name, e.g. 'uploads'
  key              text not null,                        -- `${keyPrefix}/${id}`, server-derived
  mime             text not null,
  size             bigint not null check (size between 0 and 9007199254740991),
  sha256           char(64) check (sha256 ~ '^[0-9a-f]{64}$'),   -- only with verify: 'hash'
  etag             text,
  status           text not null default 'pending' check (status in ('pending', 'ready', 'deleting')),
  expires_at       timestamptz(3) not null,              -- when the PUT URL dies (DB time)
  cleanup_at       timestamptz(3),                       -- when the sweep may act; null on ready rows
  cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  created_at       timestamptz(3) not null default now(),
  confirmed_at     timestamptz(3),
  unique (bucket, key),
  check (status <> 'ready' or (confirmed_at is not null and cleanup_at is null)),
  check (status = 'ready' or cleanup_at is not null)
);
create index files_owner_idx on files (owner_id, created_at desc, id desc);      -- keyset page per owner
create index files_sweep_idx on files (cleanup_at, id) where status <> 'ready';  -- the one sweep predicate
```

`filesTable(kit, { owner, name? })` names the constraints and indexes after the table. The kit says
where the table lives: `pgColumns()` or `pgColumns(pgSchema('storage'))` from `@arki/db/pg`. There is no
foreign key on `owner_id`: deleting an owner must not drop the row that carries the cleanup duty.

### States

```text
createUpload ──► pending ──confirm──► ready ──remove──► deleting ──sweep──► (row gone)
                    │                                       ▲
                    ├──remove (cleanup_at = expires_at+grace)┘
                    └──no confirm by expires_at+grace ──sweep claims──┘
```

`cleanup_at` is the only clock the sweep reads. Pending: `expires_at + grace`. Deleting from ready:
`now()`. Deleting from pending: `greatest(now(), expires_at + grace)`, so a PUT still in flight lands
before the delete.

### Options

| Option             | Default    | Meaning                                                                        |
| ------------------ | ---------- | ------------------------------------------------------------------------------ |
| `files`            | required   | the table from `filesTable`                                                    |
| `bucket`           | required   | stable binding name stored in every row                                        |
| `limits`           | required   | `{ maxSize, allowedMime }`; `allowedMime` takes `image/*` wildcards            |
| `keyPrefix`        | `'files'`  | keys are `${keyPrefix}/${fileId}`                                              |
| `uploadTtlSeconds` | 300        | life of a PUT URL                                                              |
| `urlTtlSeconds`    | 300        | default life of a GET URL                                                      |
| `maxUrlTtlSeconds` | 3600       | longest GET URL; longer is rejected, never clamped                             |
| `graceSeconds`     | 900        | how long after expiry a PUT may still land                                     |
| `verify`           | `'head'`   | `'hash'` also downloads the object and stores its SHA-256 (holds it in memory) |
| `policy`           | owner only | `canCreate`, `canRead`, `canRemove`                                            |

Pass the root Drizzle database, never a transaction. Storage I/O never runs inside one.

## Guarantees

- **G1** No URL is returned before its pending row commits.
- **G2** A row is `ready` only after the server read the object's metadata and size and type matched the row.
- **G3** Keys are server-derived. A client can reach only keys it holds a row for, through the policy.
- **G4** Issued PUT grants are create-only: they cannot replace an existing object (given the store enforces `If-None-Match`; `bun run test:live` checks it).
- **G5** Every URL expires: PUT after `uploadTtlSeconds`, GET after at most `maxUrlTtlSeconds`.
- **G6** A `ready` row never points at an object this library deleted. Confirm and sweep cannot both win.
- **G7** Every pending row older than `expires_at + grace`, and every `deleting` row, is removed (row and
  object) by later sweeps, once the store answers. Failures retry with backoff up to one day.

### Not promised

- No atomic commit across Postgres and the store (no 2PC). Two-phase delete and the sweep close the gap.
- No immediate revocation. An issued GET URL works until it expires. Convex's `getUrl` URLs live until
  the file is deleted (https://docs.convex.dev/file-storage/serve-files); we do not copy that.
- An upload accepted before expiry may finish after it. `graceSeconds` covers this; a PUT later than
  `expires_at + grace` after a removal can leave an orphan object with no row.
- MIME is the declared type, not a sniffed format. A checksum does not mean safe content.
- No ingress cap beyond the signed `Content-Length`. Single PUT only (S3 caps one PUT at 5 GB).

Live enforcement of the signed headers on S3 and R2 is proven by `bun run test:live` (it needs a
bucket; see the file header of `src/storage/__tests__/signed-upload.live.test.ts`).

## Bucket setup

- Keep the bucket private. Every read goes through `storage.url`.
- CORS must allow `PUT` (and `GET` for downloads) from your origins, with the headers `Content-Type`
  and `If-None-Match`:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type", "If-None-Match"],
    "MaxAgeSeconds": 3600
  }
]
```

Check CORS once by hand in a real browser after setup.

## Cleanup

Abandoned uploads and removals are finished by a sweep. Schedule it in the app, one replica at a time:

```ts
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
```

The rows hold the duty, so a missed tick loses nothing. Two sweepers never take the same row.

## SQLite

`@arki/fs/sqlite` runs the same table, lifecycle and sweep on SQLite through libSQL
(`createLibsqlDb` from `@arki/db/libsql`). Import from `@arki/fs/sqlite` instead of `@arki/fs/pg`. The
table is written once; only the kit changes:

```ts
// model/tables.ts (server): the same table on the SQLite kit; `prefix` stands in for a Postgres schema
export const files = filesTable(sqliteColumns({ prefix: 'storage_' }), { owner: userId });

// infra (boot): `db` is the root handle from `createLibsqlDb({ url: 'file:app.db', relations })`
export function buildStorage(db: FilesDb, adapter: SignedUploadAdapter) {
  return fileStorage(db, adapter, {
    files,
    bucket: 'uploads',
    limits: { maxSize: 20_000_000, allowedMime: ['image/*', 'application/pdf'] },
  });
}
```

SQLite has no schemas, so `prefix` goes before the table and index names instead. Every option,
failure and guarantee above holds. What differs:

- Deadlines still come from the database clock, as on Postgres: `unixepoch('subsec')` in integer
  milliseconds. `greatest`/`least` become `max()`/`min()`, intervals become milliseconds.
- Timestamps keep milliseconds. Postgres keeps them too here (`timestamptz(3)`), so values agree.
- Cleanup workers in different processes take turns instead of running in parallel. SQLite has one
  writer and no `SKIP LOCKED`, so the sweep claims rows with one
  `UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING` inside a write transaction (`BEGIN IMMEDIATE`).
  Two sweepers still never take the same row.
- The sha256 check uses `regexp` (libSQL ships it). The `char(64)` limit is enforced by a `length()`
  CHECK the column kit adds, since SQLite ignores declared lengths.
- A CHECK failure is `SQLITE_CONSTRAINT_CHECK` (`rawCode` 275); `@arki/db` reads it as SQLSTATE 23514.

## Local development

The local adapter cannot sign uploads, so `fileStorage` refuses it (a compile error, and
`ARKI_FS_E006` at runtime). Use MinIO or a dev R2 bucket. In tests, use `memoryUploadAdapter()` from
`@arki/fs/testing`; its `browserPut(url, body, headers)` plays the browser's PUT and enforces the
signed headers.

## Failures and errors

Outcomes a correct caller must handle are **returned** as failures from `@arki/failure`, never thrown.
Each storage call returns its value or one of these. Check with `isFailure(result)` or
`FileUnavailable.is(result)`, and return the failure on. They are exported from `@arki/fs/files`, so a
browser can `reviveRpcError(error, [FileUnavailable, ...])` them.

| Failure           | Code                  | Status | Returned by            | Meaning                                                                               |
| ----------------- | --------------------- | ------ | ---------------------- | ------------------------------------------------------------------------------------- |
| `FileUnavailable` | `fs.file_unavailable` | 404    | every call             | missing, not yours, another bucket binding, or the policy refused (no existence leak) |
| `UploadPending`   | `fs.upload_pending`   | 409    | `confirmUpload`        | the PUT has not landed yet; the row stays pending, so confirming again later is fine  |
| `FileWrongState`  | `fs.file_wrong_state` | 409    | `confirmUpload`, `url` | not ready (for `url`), being deleted, or the confirm window passed                    |
| `UploadMismatch`  | `fs.upload_mismatch`  | 422    | `confirmUpload`        | stored size, type or hash differs from the request; the row is now deleting           |

`createUpload` also returns failures from `ID_GENERATION_FAILURES` (`@arki/contracts`) before inserting a row or signing a URL. The exported `CREATE_UPLOAD_FAILURES` tuple defines both its return failures and its native RPC error map. Narrow the result with `isFailure`; an unavailable or broken random provider must never become an object key.

`FileUnavailable` is one failure on purpose: a missing file and a denied one look the same, so a caller
cannot probe which files exist. The `arki:fs` debug log says which it was. Its `fileId` is absent only
when the policy refused a new upload.

`filesContract` lists these per procedure (`errorMap`), so a client gets them as declared, typed
`ORPCError`s with the failure's code, status and data.

Faults stay **thrown** as a `FileStorageError` with a stable `code` and `retryable`. Match on the
code, never the message. `filesRouter` maps them to oRPC codes and puts the code in `data.code`.

| Code           | Name          | oRPC                    | Meaning                                                                      |
| -------------- | ------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `ARKI_FS_E001` | `invalid`     | `BAD_REQUEST`           | bad input or config: TTL over the cap, size over the limit, mime not allowed |
| `ARKI_FS_E006` | `unsupported` | `INTERNAL_SERVER_ERROR` | the adapter cannot sign uploads (local)                                      |
| `ARKI_FS_E007` | `storage`     | `INTERNAL_SERVER_ERROR` | the object store failed; `retryable`                                         |

E002 to E005 are retired: those outcomes are the failures above.

## Logging

`getLogger('arki:fs')`. Lifecycle at DEBUG (operation, file id, transition, duration); a failed object
delete at WARN. Signed URLs, credentials and bytes are never logged. Show it with `DEBUG=arki:fs`.

## Benchmarks

The suite is `bench/files.bench.ts` (`bun run bench`): the signer against a direct
`@aws-sdk/s3-request-presigner` call, and one upload through the lifecycle next to the raw Drizzle
statements it replaces. No in-process files-table library exists to rank against. Numbers are
published here only from an idle `bun run bench --profile publish --write-readme` run; none is
recorded yet.
