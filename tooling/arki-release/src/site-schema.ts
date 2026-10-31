/**
 * Shapes of what `site` writes for the arki.dev site app (`--out`).
 *
 * Each generated file is declared here once, as a Zod schema. `site` parses
 * every file through its schema before it writes it. The site lives in another
 * repo, so `site` also writes a self-contained copy of this module (plus the
 * schema modules it imports) to `src/generated/site-schema.ts`, and the app
 * infers its types from that copy (see `./site-schema-copy`). Import only `zod`
 * and zod-only schema modules here, or the copy fails to render.
 *
 *   src/content/packages/<short>/<version|next>/snapshot.json  -> snapshotMetaSchema
 *   src/generated/packages.json                                -> packagesFileSchema
 *   src/generated/errors.json                                  -> errorsFileSchema
 *   src/generated/examples.json                                -> examplesFileSchema
 *   src/generated/demos.json                                   -> demosFileSchema
 *   src/generated/dot-new.json                                 -> dotNewFileSchema
 *   src/generated/inside-proofs.json                           -> insideProofsFileSchema
 *
 * `site` also reads one input with a schema here: the proof spec
 * `docs/arki/inside-proofs.json` -> insideProofsSpecSchema.
 */

import { z } from 'zod';

import { errorEntrySchema } from '@arki/library-tooling/error-index-schema';

import { docExamplesReportSchema } from './doc-examples-report-schema';

/** `published`: an npm version, immutable once written. `next`: the newest candidate, rewritten each run. */
export const SITE_CHANNELS = ['published', 'next'] as const;
export type SiteChannel = (typeof SITE_CHANNELS)[number];

/**
 * Where a package's "latest" page comes from: the newest npm version when its
 * snapshot has docs, else the candidate (`next`), else the newest npm version's
 * README-only snapshot (`archive`), else nothing (`none`).
 */
export const LATEST_SOURCES = ['published', 'next', 'archive', 'none'] as const;

/** `measured`: the README holds a bench block with provenance. */
export const BENCH_STATUSES = ['measured', 'none'] as const;

/** The candidate a `next` snapshot was copied from: what the "unreleased" banner shows. */
export const candidateRefSchema = z.object({
  wave: z.string(),
  sourceCommit: z.string(),
  createdAt: z.string(),
});

/** `snapshot.json` in every `<short>/<version|next>/` folder. */
export const snapshotMetaSchema = z.object({
  name: z.string(),
  channel: z.enum(SITE_CHANNELS),
  version: z.string(),
  /** True when the tarball had no `docs/` and no `llms.txt`: only README (and CHANGELOG) were kept. */
  archive: z.boolean(),
  /** Hex sha512 of the tarball the files came from. */
  sha512: z.string(),
  /** Snapshot-relative paths of the copied files, sorted. */
  files: z.array(z.string()),
  /** Set for `next` snapshots only. */
  candidate: candidateRefSchema.nullable(),
  /** `arki-doc-examples --json` result recorded in the candidate; null when none was recorded. */
  examples: docExamplesReportSchema.nullable(),
  /** The tarball manifest's `engines`. */
  engines: z.record(z.string(), z.string()),
  /** The tarball manifest's `license` (an SPDX id); null when it has none or the snapshot was written before this field existed. */
  license: z.string().nullable().default(null),
  benchStatus: z.enum(BENCH_STATUSES),
});

/** A gap on a package page: a readiness check, or a demo's `lib-gaps.md` row (with its issue, once filed). */
export const openGapSchema = z.object({
  kind: z.enum(['readiness', 'demo']),
  title: z.string(),
  /** Issue on `arki-labs/arki`; null for readiness checks and rows not filed yet. */
  url: z.string().nullable(),
  /** Demo that found the gap; null for readiness checks. */
  foundBy: z.string().nullable(),
});

export const packageEntrySchema = z.object({
  name: z.string(),
  /** Folder under `src/content/packages/`. */
  short: z.string(),
  /** 1 = stack, 2 = standalone library, null = untiered. */
  tier: z.union([z.literal(1), z.literal(2)]).nullable(),
  wave: z.string(),
  status: z.enum(LATEST_SOURCES),
  /** Newest npm version with a snapshot on disk; null when never published. */
  npmVersion: z.string().nullable(),
  /** Version in the newest candidate; null when no candidate holds the package. */
  nextVersion: z.string().nullable(),
  /** Banner data when `status` is `next`. */
  candidate: candidateRefSchema.nullable(),
  /** Every snapshot folder, newest first; `next` last. */
  versions: z.array(z.object({ version: z.string(), channel: z.enum(SITE_CHANNELS), archive: z.boolean() })),
  runtimes: z.record(z.string(), z.string()),
  benchStatus: z.enum(BENCH_STATUSES),
  hasLlms: z.boolean(),
  examples: z.object({ compiled: z.number(), run: z.number(), skipped: z.number() }).nullable(),
  demos: z.array(z.object({ name: z.string(), pin: z.string().nullable() })),
  /** `https://github.com/arki-labs/<short>`, the read-only mirror `sync` maintains. */
  mirror: z.string(),
  /** Readiness items still in `readiness-baseline.json`, and open rows of a demo's `lib-gaps.md` that name this package. */
  openGaps: z.array(openGapSchema),
});
export const packagesFileSchema = z.array(packageEntrySchema);

/** Error codes of each package's latest snapshot (`errors.json` in the tarball). */
export const errorsFileSchema = z.array(
  errorEntrySchema.extend({ version: z.string(), channel: z.enum(SITE_CHANNELS) }),
);

export const examplesFileSchema = z.array(
  z.object({ name: z.string(), version: z.string(), report: docExamplesReportSchema }),
);

export const demosFileSchema = z.array(
  z.object({
    name: z.string(),
    repo: z.string(),
    /** False when the demo folder is not checked out. */
    present: z.boolean(),
    /** `pinned` is null when the demo links the package from source (no release yet), as in `DemoPin`. */
    pins: z.array(z.object({ name: z.string(), pinned: z.string().nullable() })),
  }),
);

/** One file `dot new --dry-run --json` plans (the CLI's printed contract). */
const dotNewOperationSchema = z.object({
  path: z.string(),
  action: z.string(),
  contentHash: z.string(),
  contentBytes: z.number(),
  reason: z.string(),
});

/** The `data` of `dot new --dry-run --json`, as printed by the candidate's CLI. */
export const dotNewResultSchema = z.object({
  app: z.object({ name: z.string(), target: z.string() }),
  operations: z.array(dotNewOperationSchema),
  nextSteps: z.array(z.string()),
});

export const dotNewFileSchema = z.object({
  /** Version of the `@arki/dot` tarball the plan came from. */
  version: z.string(),
  candidate: candidateRefSchema,
  templates: z.array(z.object({ template: z.string(), result: dotNewResultSchema })),
});

/** A 1-based, inclusive line range in a file: `"12"` or `"12-18"`. */
export const lineRangeSchema = z
  .string()
  .regex(/^[1-9]\d*(-[1-9]\d*)?$/)
  .refine(range => {
    const [from = 0, to = from] = range.split('-').map(Number);
    return to >= from;
  }, 'a line range ends before it starts');

/** A range the proof spec quotes. `anchor`: the first 16 hex chars of the sha256 of its lines, joined with `\n`. */
const insideProofSpecPartSchema = z.strictObject({
  lines: lineRangeSchema,
  anchor: z.string().regex(/^[0-9a-f]{16}$/),
});

/**
 * `docs/arki/inside-proofs.json`: the arki source lines the "What's inside" page on arki.dev quotes, keyed by a
 * stable id (`<package>.<topic>`) that the page's rows reference. `path` is relative to the repo root. `imports` are
 * ranges of the same file the page shows above the code. `site` copies each range and refuses one whose anchor no
 * longer matches the lines.
 */
export const insideProofsSpecSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/),
  insideProofSpecPartSchema.extend({
    path: z
      .string()
      .regex(/^[\w@.-]+(\/[\w@.-]+)*$/)
      .refine(file => !file.split('/').includes('..'), 'a proof path stays inside the repo'),
    imports: z.array(insideProofSpecPartSchema).default([]),
  }),
);

/** A range as the site shows it: its line numbers and the exact text of those lines. */
const insideProofPartSchema = z.object({ lines: lineRangeSchema, code: z.string() });

/** One quote on the "What's inside" page, copied by `site` from the arki repo. */
export const insideProofSchema = insideProofPartSchema.extend({
  path: z.string(),
  imports: z.array(insideProofPartSchema),
});

/** `src/generated/inside-proofs.json`, keyed by the spec's ids, in spec order. */
export const insideProofsFileSchema = z.record(z.string(), insideProofSchema);

export type SnapshotMeta = z.output<typeof snapshotMetaSchema>;
export type PackageEntry = z.output<typeof packageEntrySchema>;
export type DotNewFile = z.output<typeof dotNewFileSchema>;
export type InsideProof = z.output<typeof insideProofSchema>;
export type InsideProofsFile = z.output<typeof insideProofsFileSchema>;
