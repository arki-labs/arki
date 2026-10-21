import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';
import { createFileRoute } from '@tanstack/react-router';

import { latestSnapshotFolder, packageDocHref } from '~/features/site-data/package-urls';
import { listGuidesFn, listPackageDocsFn, listPackagesFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';

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
    const recipes = snapshots.flatMap(({ short, folder, found }) =>
      found === null
        ? []
        : found.docs
            .filter(doc => doc.path.startsWith(recipesFolder))
            .map(doc => ({
              href: packageDocHref(short, folder, doc.path),
              title: doc.title,
              forPackage: `${found.snapshot.name}@${found.snapshot.version}`,
            })),
    );
    const siteGuides = guides.map(guide => ({
      href: `/docs/guides/${guide.slug}`,
      title: guide.title,
      forPackage: null,
    }));
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
    <PageContainer
      breadcrumbs={{
        items: [
          { label: 'Docs', href: '/docs' },
          { label: 'Guides', href: '/docs/guides' },
        ],
      }}
    >
      <Shell className="sm:py-8 md:py-12">
        <h1>Guides</h1>
        <p>Step-by-step recipes. Each one ends with a command that checks the result.</p>
        {guides.length === 0 ? (
          <p data-testid="guides-empty">No guides yet.</p>
        ) : (
          <ul>
            {guides.map(guide => (
              <li key={guide.href}>
                <a href={guide.href} data-testid="guide-link">
                  {guide.title}
                </a>
                {guide.forPackage !== null && (
                  <span className="text-sm text-muted-foreground">
                    {' '}
                    for <code>{guide.forPackage}</code>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Shell>
    </PageContainer>
  );
}
