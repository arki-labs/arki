import type { listPackageDocsFn } from '~/features/site-data/site-data';
import { packageDocHref } from '~/features/site-data/package-urls';

/**
 * `/docs` is ordered by the jobs a reader comes to do, not by package. Each job names the package docs that answer
 * it (`path` without `.md`, `hash` a section id) and the background concept docs; titles come from the docs.
 */

type DocRef = { short: string; path: string; hash?: string };

type DocJob = {
  id: string;
  title: string;
  summary: string;
  docs: readonly DocRef[];
  /** Site pages that answer the job too, beside the package docs. */
  pages: readonly { href: string; label: string }[];
  /** Concept docs: linked from the task, never the other way round. */
  concepts: readonly DocRef[];
};

const dot = (path: string, hash?: string): DocRef =>
  hash === undefined ? { short: 'dot', path } : { short: 'dot', path, hash };

export const DOC_JOBS = [
  {
    id: 'create-an-app',
    title: 'Create an app',
    summary: 'Start a new app, read its graph and check that it boots.',
    docs: [dot('docs/quickstart'), dot('docs/cli')],
    pages: [{ href: '/docs/dot-new', label: 'What dot new writes' }],
    concepts: [dot('docs/principles'), dot('docs/lifecycle')],
  },
  {
    id: 'add-a-feature',
    title: 'Add a feature',
    summary: 'Add a slice of your product: its usecases, infra and entrypoints.',
    docs: [
      dot('docs/agent-guide', 'add-a-feature'),
      dot('docs/actions'),
      dot('docs/plugin-authoring'),
      dot('docs/testing'),
    ],
    pages: [],
    concepts: [dot('docs/composition-doctrine'), dot('docs/di')],
  },
  {
    id: 'inspect-a-failure',
    title: 'Inspect a failure',
    summary: 'Find out why an app does not wire, boot or answer.',
    docs: [dot('docs/diagnostics'), dot('docs/observability')],
    pages: [{ href: '/errors', label: 'Error codes' }],
    concepts: [dot('docs/lifecycle')],
  },
  {
    id: 'deploy',
    title: 'Deploy',
    summary: 'Build the container image, run it and check that it serves.',
    docs: [dot('docs/recipes/deploy'), dot('docs/operations')],
    pages: [],
    concepts: [],
  },
  {
    id: 'upgrade',
    title: 'Upgrade',
    summary: 'Move an app to a new version of the packages.',
    docs: [dot('docs/recipes/upgrade'), dot('docs/upgrade-guide'), dot('docs/release-policy')],
    pages: [{ href: '/docs/upgrade-story', label: 'Upgrade story' }],
    concepts: [],
  },
] as const satisfies readonly DocJob[];

type SnapshotDocs = NonNullable<Awaited<ReturnType<typeof listPackageDocsFn>>>['docs'];

/** A package's latest snapshot folder and its docs, keyed by short name. */
export type LatestDocs = ReadonlyMap<string, { folder: string; docs: SnapshotDocs }>;

/**
 * Links for doc refs, titled from the docs. A ref whose doc the latest snapshot lacks is left out: doc paths change
 * between versions, and a link that 404s is worse than none. A missing section falls back to the whole doc.
 */
export function resolveDocLinks(refs: readonly DocRef[], latest: LatestDocs) {
  return refs.flatMap(ref => {
    const snapshot = latest.get(ref.short);
    const doc = snapshot?.docs.find(candidate => candidate.path === ref.path);
    if (snapshot === undefined || doc === undefined) return [];
    const href = packageDocHref(ref.short, snapshot.folder, ref.path);
    const heading = doc.headings.find(candidate => candidate.id === ref.hash);
    if (heading === undefined) return [{ href, title: doc.title }];
    return [{ href: `${href}#${heading.id}`, title: `${doc.title}: ${heading.text}` }];
  });
}
