import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';
import { createFileRoute } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';
import { DOC_JOBS, resolveDocLinks } from './-doc-jobs';
import { loadLatestDocs } from './-latest-docs';

export const Route = createFileRoute('/docs/')({
  loader: async () => {
    const shorts = [...new Set(DOC_JOBS.flatMap(job => [...job.docs, ...job.concepts].map(ref => ref.short)))];
    const loaded = await Promise.all(shorts.map(short => loadLatestDocs(short)));
    const found = loaded.filter(entry => entry !== null);
    const latest = new Map(found.map(entry => [entry.short, entry]));
    return {
      jobs: DOC_JOBS.map(job => ({
        id: job.id,
        title: job.title,
        summary: job.summary,
        links: [
          ...resolveDocLinks(job.docs, latest),
          ...job.pages.map(page => ({ href: page.href, title: page.label })),
        ],
        concepts: resolveDocLinks(job.concepts, latest),
      })),
      snapshots: found.map(entry => ({
        name: entry.snapshot.name,
        version: entry.snapshot.version,
        channel: entry.snapshot.channel,
      })),
    };
  },
  head: () =>
    getDefaultMeta({
      title: 'Docs',
      description: 'Arki docs by task: create an app, add a feature, inspect a failure, deploy, upgrade.',
    }),
  component: DocsIndexPage,
});

function DocsIndexPage() {
  const { jobs, snapshots } = Route.useLoaderData();

  return (
    <PageContainer breadcrumbs={{ items: [{ label: 'Docs', href: '/docs' }] }}>
      <Shell className="sm:py-8 md:py-12">
        <header>
          <h1>Docs</h1>
          <p>Start from what you want to do. Each task links to the pages that answer it.</p>
          {snapshots.map(snapshot => (
            <p key={snapshot.name} className="text-sm text-muted-foreground">
              For <code>{`${snapshot.name}@${snapshot.version}`}</code>
              {snapshot.channel === 'next' && ' (not on npm yet: release candidate)'}
            </p>
          ))}
        </header>

        <nav aria-label="Tasks">
          <ol>
            {jobs.map(job => (
              <li key={job.id}>
                <a href={`#${job.id}`}>{job.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        {jobs.map(job => (
          <section key={job.id} id={job.id} aria-labelledby={`${job.id}-title`} data-testid="doc-job">
            <h2 id={`${job.id}-title`}>{job.title}</h2>
            <p>{job.summary}</p>
            {job.links.length === 0 ? (
              <p>No page answers this yet.</p>
            ) : (
              <ul>
                {job.links.map(link => (
                  <li key={link.href}>
                    <a href={link.href} data-testid="doc-job-link">
                      {link.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {job.concepts.length > 0 && (
              <>
                <h3>Background</h3>
                <ul>
                  {job.concepts.map(link => (
                    <li key={link.href}>
                      <a href={link.href} data-testid="doc-job-link">
                        {link.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        ))}

        <section aria-labelledby="docs-more-title">
          <h2 id="docs-more-title">More</h2>
          <ul>
            <li>
              <a href="/docs/guides">Guides</a>: step-by-step recipes that end with a command to check the result.
            </li>
            <li>
              <a href="/docs/glossary">Glossary</a>: the words these docs use.
            </li>
            <li>
              <a href="/packages">Packages</a>: every package with its docs.
            </li>
          </ul>
        </section>
      </Shell>
    </PageContainer>
  );
}
