import { allGuides, allPackageDocs } from 'content-collections';

import {
  demosFileSchema,
  dotNewFileSchema,
  errorsFileSchema,
  examplesFileSchema,
  packagesFileSchema,
  snapshotMetaSchema,
} from '@arki/arki-release/site-schema';

import demosFile from '~/generated/demos.json';
import dotNewFile from '~/generated/dot-new.json';
import errorsFile from '~/generated/errors.json';
import examplesFile from '~/generated/examples.json';
import packagesFile from '~/generated/packages.json';

/**
 * The site's data, server only (`*.server.ts` never reaches the browser bundle): the generated JSON files and
 * snapshot metadata, each parsed once through its schema when this module loads, and the compiled package docs.
 * Lookups return `null` for an unknown package, version, path or code; routes turn that into `notFound()`.
 */

const packages = packagesFileSchema.parse(packagesFile);
const errors = errorsFileSchema.parse(errorsFile);
const examples = examplesFileSchema.parse(examplesFile);
const demos = demosFileSchema.parse(demosFile);
const dotNew = dotNewFileSchema.parse(dotNewFile);

const packagesByShort = new Map(packages.map(entry => [entry.short, entry]));
const errorsByCode = new Map(errors.map(entry => [entry.code, entry]));

const snapshotFolder = /\/content\/packages\/([^/]+\/[^/]+)\/[^/]+$/;

/** `<short>/<version>` of a globbed snapshot file. */
function snapshotKeyOf(file: string): string {
  const key = snapshotFolder.exec(file)?.[1];
  if (key === undefined) throw new Error(`site-data: ${file} is not in a snapshot folder`);
  return key;
}

const snapshots = new Map(
  Object.entries(
    import.meta.glob<unknown>('../../content/packages/*/*/snapshot.json', { eager: true, import: 'default' }),
  ).map(([file, value]) => [snapshotKeyOf(file), snapshotMetaSchema.parse(value)]),
);

/** Files at the root of each snapshot, loaded on demand so each stays its own server chunk. */
const snapshotRootFiles = new Map(
  Object.entries(import.meta.glob<string>('../../content/packages/*/*/*', { query: '?raw', import: 'default' })).map(
    ([file, load]) => [`${snapshotKeyOf(file)}/${file.slice(file.lastIndexOf('/') + 1)}`, load],
  ),
);

/** The snapshot files text and JSON routes serve as they are. */
export const SNAPSHOT_RAW_FILES = ['api.json', 'llms.txt', 'AGENTS.md'] as const;

const docsBySnapshot = Map.groupBy(allPackageDocs, doc => doc._meta.directory.split('/').slice(0, 2).join('/'));
const guidesBySlug = new Map(allGuides.map(guide => [guide.slug, guide]));

/** A package and one of its snapshots, or null when either is unknown. */
function findSnapshot(short: string, version: string) {
  const entry = packagesByShort.get(short);
  const snapshot = snapshots.get(`${short}/${version}`);
  if (entry === undefined || snapshot === undefined) return null;
  return { package: entry, snapshot };
}

export function listPackages() {
  return packages;
}

export function findPackage(short: string) {
  return packagesByShort.get(short) ?? null;
}

/** The docs of one snapshot (no html), with the package and the snapshot metadata. */
export function listPackageDocs(short: string, version: string) {
  const found = findSnapshot(short, version);
  if (found === null) return null;
  const docs = (docsBySnapshot.get(`${short}/${version}`) ?? []).map(doc => ({
    path: doc.path,
    title: doc.title,
    headings: doc.headings,
  }));
  return { ...found, docs };
}

/** One doc page: `path` is the doc's path in the snapshot without `.md` (`README`, `docs/quickstart`). */
export function findPackageDoc(short: string, version: string, path: string) {
  const found = findSnapshot(short, version);
  const doc = docsBySnapshot.get(`${short}/${version}`)?.find(candidate => candidate.path === path);
  if (found === null || doc === undefined) return null;
  return { ...found, doc: { path: doc.path, title: doc.title, html: doc.html, headings: doc.headings } };
}

/** One of `SNAPSHOT_RAW_FILES` from a snapshot, as text; null when the snapshot does not hold it. */
export async function readSnapshotFile(short: string, version: string, file: (typeof SNAPSHOT_RAW_FILES)[number]) {
  const load = snapshotRootFiles.get(`${short}/${version}/${file}`);
  return load === undefined ? null : await load();
}

export function listErrors() {
  return errors;
}

export function findError(code: string) {
  return errorsByCode.get(code) ?? null;
}

export function listExamples() {
  return examples;
}

export function listDemos() {
  return demos;
}

export function getDotNew() {
  return dotNew;
}

export function listGuides() {
  return allGuides.map(guide => ({ slug: guide.slug, title: guide.title, headings: guide.headings }));
}

export function findGuide(slug: string) {
  const guide = guidesBySlug.get(slug);
  if (guide === undefined) return null;
  return { slug: guide.slug, title: guide.title, html: guide.html, headings: guide.headings };
}
