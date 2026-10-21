import { latestSnapshotFolder } from '~/features/site-data/package-urls';
import { getPackageFn, listPackageDocsFn } from '~/features/site-data/site-data';

/**
 * The docs in a package's latest snapshot (`next` while a candidate exists, else the newest npm version), with the
 * folder its URLs use. Null when the package is unknown or has no snapshot: links into it are then left out.
 */
export async function loadLatestDocs(short: string) {
  const entry = await getPackageFn({ data: { short } });
  const folder = entry === null ? null : latestSnapshotFolder(entry);
  if (folder === null) return null;
  const found = await listPackageDocsFn({ data: { short, version: folder } });
  if (found === null) return null;
  return { short, folder, snapshot: found.snapshot, docs: found.docs };
}
