import { createFileRoute, Link } from '@tanstack/react-router';

import config from '~/config';
import { latestSnapshotFolder, packageDocHref } from '~/features/site-data/package-urls';
import { getPackageDocFn, getPackageFn, listPackageDocsFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';
import { Pill } from '~/shared/site-chrome';
import { demoteHtmlHeadings, upgradeDocsOf, upgradeStep } from './-upgrade-story';

const recipePath = 'docs/recipes/upgrade';

export const Route = createFileRoute('/docs/upgrade-story')({
  loader: async () => {
    const dot = await getPackageFn({ data: { short: 'dot' } });
    const folder = dot ? latestSnapshotFolder(dot) : null;
    if (folder === null) return { version: null, folder: null, upgradeDocs: [], recipeHtml: null };
    const [listing, recipe] = await Promise.all([
      listPackageDocsFn({ data: { short: 'dot', version: folder } }),
      getPackageDocFn({ data: { short: 'dot', version: folder, path: recipePath } }),
    ]);
    return {
      version: listing?.snapshot.version ?? folder,
      folder,
      upgradeDocs: upgradeDocsOf(listing?.docs ?? []),
      recipeHtml: recipe === null ? null : demoteHtmlHeadings(recipe.doc.html, 2),
    };
  },
  head: () =>
    getDefaultMeta({
      title: `Upgrade story | ${config.appTitle}`,
      description: 'How an Arki app upgrades between Dot versions.',
    }),
  component: UpgradeStoryPage,
});

function UpgradeStoryPage() {
  const { version, folder, upgradeDocs, recipeHtml } = Route.useLoaderData();

  return (
    <>
      <main id="content">
        <article className="us-article">
          <nav aria-label="Breadcrumb" className="us-crumb">
            <Link to="/docs">Docs</Link> <span aria-hidden="true">/</span>{' '}
            <span aria-current="page">Upgrade story</span>
          </nav>
          <h1 className="us-h1">Upgrade story</h1>
          <p className="us-lead">How an Arki app upgrades between Dot versions.</p>

          <section className="us-empty" role="status" aria-labelledby="no-story" data-testid="upgrade-no-story">
            <span className="g" aria-hidden="true">
              ◌
            </span>
            <div>
              <h2 id="no-story">No recorded upgrade yet</h2>
              <p>
                We have not recorded an upgrade of a real app yet. This page will show one when we have: the files that
                changed, the checks that failed, the fixes, and the final state. Until then there is no timeline here.
              </p>
            </div>
          </section>

          <section aria-labelledby="procedure">
            <h2 id="procedure">The upgrade procedure</h2>
            {recipeHtml === null ? (
              <p className="us-muted">The Dot upgrade procedure is not published on the site yet.</p>
            ) : (
              // Compiled at build time from our own `docs/recipes/upgrade` by `compileMarkdown`; not user input.
              <div className="us-recipe" dangerouslySetInnerHTML={{ __html: recipeHtml }} />
            )}
          </section>

          <section aria-labelledby="upgrade-docs">
            <h2 id="upgrade-docs">Upgrade docs{version === null ? '' : ` for @arki/dot ${version}`}</h2>
            {folder !== null && upgradeDocs.length > 0 ? (
              <ul className="us-docs" data-testid="upgrade-docs">
                {upgradeDocs.map(doc => {
                  const step = upgradeStep(doc.path);
                  return (
                    <li key={doc.path}>
                      <a href={packageDocHref('dot', folder, doc.path)}>{doc.title}</a>
                      {step !== null && (
                        <>
                          {' '}
                          <Pill kind="st-next" glyph="◐">
                            {step}
                          </Pill>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="us-muted" data-testid="upgrade-docs-empty">
                The Dot upgrade docs are not published on the site yet.
              </p>
            )}
          </section>
        </article>
      </main>

      <aside className="rail" aria-label="On this page">
        <h2>On this page</h2>
        <ul>
          <li>
            <a href="#no-story">No recorded upgrade yet</a>
          </li>
          <li>
            <a href="#procedure">The upgrade procedure</a>
          </li>
          <li>
            <a href="#upgrade-docs">Upgrade docs</a>
          </li>
        </ul>
      </aside>
    </>
  );
}
