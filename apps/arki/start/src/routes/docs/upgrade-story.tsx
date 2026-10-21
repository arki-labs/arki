import { createFileRoute } from '@tanstack/react-router';

import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import config from '~/config';
import { latestSnapshotFolder, packageDocHref } from '~/features/site-data/package-urls';
import { getPackageFn, listPackageDocsFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';

const upgradeDocPrefix = 'docs/upgrade';

export const Route = createFileRoute('/docs/upgrade-story')({
  loader: async () => {
    const dot = await getPackageFn({ data: { short: 'dot' } });
    const version = dot ? latestSnapshotFolder(dot) : null;
    if (!version) return { version: null, upgradeDocs: [] };
    const listing = await listPackageDocsFn({ data: { short: 'dot', version } });
    const upgradeDocs = (listing?.docs ?? []).filter(doc => doc.path.startsWith(upgradeDocPrefix));
    return { version, upgradeDocs };
  },
  head: () =>
    getDefaultMeta({
      title: `Upgrade story | ${config.appTitle}`,
      description: 'How an Arki app upgrades between Dot versions.',
    }),
  component: UpgradeStoryPage,
});

function UpgradeStoryPage() {
  const { version, upgradeDocs } = Route.useLoaderData();

  return (
    <PageContainer>
      <Shell className="sm:py-8 md:py-12">
        <h1>Upgrade story</h1>
        <section data-testid="upgrade-no-story" aria-labelledby="no-story">
          <h2 id="no-story">No recorded upgrade yet</h2>
          <p>
            We have not recorded an upgrade of a real app yet. This page will show one when we have: the files that
            changed, the checks that failed, the fixes, and the final state. Until then there is no timeline here.
          </p>
        </section>

        <section aria-labelledby="procedure">
          <h2 id="procedure">The upgrade procedure</h2>
          <p>Dot documents each upgrade, version by version. Start with these pages.</p>
          {version && upgradeDocs.length > 0 ? (
            <ul data-testid="upgrade-docs">
              {upgradeDocs.map(doc => (
                <li key={doc.path}>
                  <a href={packageDocHref('dot', version, doc.path)}>{doc.title}</a>
                </li>
              ))}
            </ul>
          ) : (
            <p data-testid="upgrade-docs-empty">The Dot upgrade docs are not published on the site yet.</p>
          )}
        </section>
      </Shell>
    </PageContainer>
  );
}
