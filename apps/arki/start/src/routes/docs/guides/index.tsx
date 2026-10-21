import { createFileRoute } from '@tanstack/react-router';

import { latestSnapshotFolder, packageDocHref } from '~/features/site-data/package-urls';
import {
  getGuideFn,
  getPackageDocFn,
  listGuidesFn,
  listPackageDocsFn,
  listPackagesFn,
} from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';
import { DrawingIndex, FeatureSheet } from '~/shared/marketing/drawing-sheet';
import { DrawingSet } from '~/shared/marketing/drawing-set';
import { lastShellCommand } from '../-guide-check';

/** Where Stack packages keep task recipes in their docs. */
const recipesFolder = 'docs/recipes/';

/**
 * The guide index is the union of the Stack packages' recipes, linked where they live (the package doc pages, which
 * rewrite their links and show the version), and the cross-package guides in `src/content/guides/`.
 */
export const Route = createFileRoute('/docs/guides/')({
  loader: async () => {
    const [packages, guides] = await Promise.all([listPackagesFn(), listGuidesFn()]);
    const stack = packages.flatMap(entry => {
      const folder = latestSnapshotFolder(entry);
      return entry.tier === 1 && folder !== null ? [{ short: entry.short, folder }] : [];
    });
    const snapshots = await Promise.all(
      stack.map(async ({ short, folder }) => ({
        short,
        folder,
        found: await listPackageDocsFn({ data: { short, version: folder } }),
      })),
    );
    const recipes = await Promise.all(
      snapshots.flatMap(({ short, folder, found }) =>
        found === null
          ? []
          : found.docs
              .filter(doc => doc.path.startsWith(recipesFolder))
              .map(async doc => {
                const page = await getPackageDocFn({ data: { short, version: folder, path: doc.path } });
                return {
                  href: packageDocHref(short, folder, doc.path),
                  title: doc.title,
                  forPackage: `${found.snapshot.name}@${found.snapshot.version}`,
                  check: page === null ? null : lastShellCommand(page.doc.html),
                };
              }),
      ),
    );
    const siteGuides = await Promise.all(
      guides.map(async guide => {
        const page = await getGuideFn({ data: { slug: guide.slug } });
        return {
          href: `/docs/guides/${guide.slug}`,
          title: guide.title,
          forPackage: null,
          check: page === null ? null : lastShellCommand(page.html),
        };
      }),
    );
    return { guides: [...recipes, ...siteGuides] };
  },
  head: () =>
    getDefaultMeta({
      title: 'Guides',
      description: 'Step-by-step Arki recipes. Each one ends with a command that checks the result.',
    }),
  component: GuidesIndexPage,
});

function GuidesIndexPage() {
  const { guides } = Route.useLoaderData();

  return (
    <main id="content">
      <div className="gd-wrap">
        <nav aria-label="Breadcrumb" className="dd-crumb">
          <a href="/docs">Docs</a> / <span aria-current="page">Guides</span>
        </nav>
        <h1 className="dd-h1">Guides</h1>
        <p className="dd-lead">Step-by-step recipes. Each one ends with a command that checks the result.</p>
        {guides.length === 0 && (
          <div className="gd-empty" data-testid="guides-empty">
            <p>
              <strong>No guides yet.</strong>
            </p>
            <p>
              Recipes appear here when a Stack package publishes them. Until then, each package&apos;s docs cover its
              own setup.
            </p>
            <p>
              <a href="/packages">Browse packages</a>
            </p>
          </div>
        )}
        {/* A drawing set: the A-000 index is the table of contents, then a sheet that cuts a feature open. */}
        <DrawingSet>
          <DrawingIndex label="A-000 · Guide index" meta="Every guide ends with its check">
            {guides.map((guide, index) => (
              <tr key={guide.href} data-testid="guide-row">
                <td className="home-index-no">G-{101 + index}</td>
                <td className="home-index-title">
                  <a href={guide.href} data-testid="guide-link">
                    {guide.title}
                  </a>
                </td>
                <td className="home-index-shows">
                  {guide.forPackage === null ? null : (
                    <>
                      for <code>{guide.forPackage}</code>{' '}
                    </>
                  )}
                  {guide.check !== null && (
                    <span data-testid="guide-check">
                      ends with <code>{guide.check}</code>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td className="home-index-no">
                <a href="#a-201">A-201</a>
              </td>
              <td className="home-index-title">Section · Feature</td>
              <td className="home-index-shows">
                The waitlist feature cut open: model, usecases, infra, entrypoints
              </td>
            </tr>
          </DrawingIndex>
          <div id="a-201">
            <FeatureSheet />
          </div>
        </DrawingSet>
        <p className="dd-agents">
          For agents: <a href="/llms.txt">/llms.txt</a> lists every guide with its check command.
        </p>
      </div>
    </main>
  );
}
