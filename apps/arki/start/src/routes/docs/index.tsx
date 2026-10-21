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

function DocsLinks({ title, links }: { title: string; links: readonly { href: string; title: string }[] }) {
  return (
    <div>
      <h3>{title}</h3>
      <ul>
        {links.map(link => (
          <li key={link.href}>
            <a href={link.href} data-testid="doc-job-link">
              {link.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocsIndexPage() {
  const { jobs, snapshots } = Route.useLoaderData();

  return (
    <>
      <main id="content">
        <div className="dx-wrap">
          <h1 className="dd-h1">Docs</h1>
          <p className="dd-lead">Start from what you want to do. Each task links to the pages that answer it.</p>
          {snapshots.map(snapshot => (
            <p key={snapshot.name} className="dx-for">
              <span aria-hidden="true">!</span>
              <span>
                For <code>{`${snapshot.name}@${snapshot.version}`}</code>
                {snapshot.channel === 'next' && ' · not on npm yet: release candidate'}
              </span>
            </p>
          ))}

          <ol className="dx-jobs">
            {jobs.map((job, index) => (
              <li key={job.id} id={job.id} className="dx-job" data-testid="doc-job">
                <div className="dx-head">
                  <span className="dx-num" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h2>{job.title}</h2>
                    <p>{job.summary}</p>
                  </div>
                </div>
                <div className="dx-cols">
                  {job.links.length === 0 ? (
                    <p className="none">No page answers this yet.</p>
                  ) : (
                    <DocsLinks title="Read" links={job.links} />
                  )}
                  {job.concepts.length > 0 && <DocsLinks title="Background" links={job.concepts} />}
                </div>
              </li>
            ))}
          </ol>

          <section aria-labelledby="docs-more-title">
            <h2 id="docs-more-title" className="dx-moreh">
              More
            </h2>
            <ul className="dx-more">
              <li>
                <a href="/docs/guides">Guides</a>
                <span> — step-by-step recipes that end with a command to check the result.</span>
              </li>
              <li>
                <a href="/docs/glossary">Glossary</a>
                <span> — the words these docs use.</span>
              </li>
              <li>
                <a href="/packages">Packages</a>
                <span> — every package with its docs.</span>
              </li>
            </ul>
          </section>

          <p className="dd-agents">
            For agents: <a href="/agents">/agents</a> · <a href="/llms.txt">/llms.txt</a>
          </p>
        </div>
      </main>
      <aside className="rail" aria-label="On this page">
        <h2>On this page</h2>
        <ul>
          {jobs.map(job => (
            <li key={job.id}>
              <a href={`#${job.id}`}>{job.title}</a>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
