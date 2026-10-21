import { createFileRoute } from '@tanstack/react-router';

import { latestSnapshotFolder, packageDocHref, packageHref } from '~/features/site-data/package-urls';
import { listPackagesFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';
import { getAgentsPageFn } from './-agents-page';

export const Route = createFileRoute('/agents/')({
  loader: async () => {
    const [page, packages] = await Promise.all([getAgentsPageFn(), listPackagesFn()]);
    return { page, packages };
  },
  head: () =>
    getDefaultMeta({
      title: 'Agent benchmark',
      description: 'How we test AI coding agents on Arki, the protocol we fixed before any run, and the results.',
    }),
  component: AgentsPage,
});

const RAIL = [
  { id: 'claim', label: 'What has to be true' },
  { id: 'results', label: 'Results' },
  { id: 'design', label: 'How we will run it' },
  { id: 'protocol', label: 'The full protocol' },
  { id: 'library', label: 'Library benchmarks' },
] as const;

/** Protocol text with its `code` spans: the protocol file is markdown, and the summary cards keep its backticks. */
function Inline({ text }: { text: string }) {
  return text.split('`').map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part));
}

function AgentsPage() {
  const { page, packages } = Route.useLoaderData();
  const { summary } = page;
  const measured = packages.filter(entry => entry.benchStatus === 'measured').length;
  const libraryLine =
    measured === 0
      ? `No package publishes benchmarks yet: 0 of ${packages.length}.`
      : `${measured} of ${packages.length} packages publish benchmarks.`;

  return (
    <main id="content" className="ag-main">
      <div className="ag-layout">
        <div className="ag-body">
          <h1 className="ag-h1">Agent benchmark</h1>
          <p className="ag-lead">{summary.claim}</p>

          {page.resultsText === null && (
            <div className="ag-status" role="status" data-testid="agents-empty">
              <span className="g" aria-hidden="true">
                ◌
              </span>
              <div>
                <p className="ag-status-title">No results yet. The benchmark has not run.</p>
                <p className="ag-status-text">
                  This page shows the protocol only, so you can see how we will measure before we have a number. We
                  wrote the protocol before any run, and we publish the results whether or not they favour Arki.
                </p>
                <p className="sub ag-status-tag">
                  protocol {summary.protocolId} · amendments:{' '}
                  {summary.amendmentsNone ? 'none' : 'see the full protocol'}
                </p>
              </div>
            </div>
          )}

          <section className="sec" aria-labelledby="claim">
            <h2 id="claim">What has to be true</h2>
            <p className="ag-intro">
              We may say &ldquo;Arki is better for agents&rdquo; only if all of these hold. If any fails, we publish
              anyway and drop that headline.
            </p>
            <table className="cards" aria-label="Claim conditions">
              <thead>
                <tr>
                  <th scope="col" className="ag-idcol">
                    Id
                  </th>
                  <th scope="col">Condition</th>
                </tr>
              </thead>
              <tbody>
                {summary.claims.map(claim => (
                  <tr key={claim.id} className="card-row">
                    <th scope="row" className="mono">
                      {claim.id}
                    </th>
                    <td className="c-full">
                      <Inline text={claim.text} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="sec" aria-labelledby="results">
            <h2 id="results">Results</h2>
            {page.resultsText === null ? (
              <div className="ag-later">
                <p>
                  <span className="mono" aria-hidden="true">
                    ◌
                  </span>{' '}
                  Nothing here until the benchmark has run. Then this section shows:
                </p>
                <ul>
                  <li>
                    <strong>Results by task, stack and agent:</strong> pass rate, cost and time.
                  </li>
                  <li>
                    <strong>Where we lost:</strong> every task where Arki did worse.
                  </li>
                  <li>
                    <strong>Trace replays:</strong> the redacted steps and tool calls of each run.
                  </li>
                </ul>
              </div>
            ) : (
              <>
                <p className="ag-intro">Raw results, as the harness wrote them.</p>
                {/* A scrollable region must take keyboard focus so long lines can be read without a mouse. */}
                {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
                <pre className="ag-raw" data-testid="agents-results" tabIndex={0} aria-label="Raw results">
                  {page.resultsText}
                </pre>
              </>
            )}
          </section>

          <section className="sec" aria-labelledby="design">
            <h2 id="design">How we will run it</h2>
            <dl className="ag-design" aria-label="Benchmark design">
              {summary.design.map(row => (
                <div key={row.item}>
                  <dt>{row.item}</dt>
                  <dd>
                    <Inline text={row.value} />
                  </dd>
                </div>
              ))}
            </dl>
            <div className="hgrid ag-cards">
              <div className="panel">
                <h3>Stacks</h3>
                <ul>
                  {summary.stacks.map(stack => (
                    <li key={stack.id}>
                      <span className="sub">{stack.id}</span> {stack.name}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="panel">
                <h3>Agents</h3>
                <ul>
                  {summary.agents.map(agent => (
                    <li key={agent.id}>
                      <span className="sub">{agent.id}</span> <Inline text={agent.harness} /> with{' '}
                      <Inline text={agent.model} />
                      <span className="sub ag-verify">
                        <Inline text={agent.verification} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <table className="cards ag-tasks" aria-label="Tasks">
              <thead>
                <tr>
                  <th scope="col" className="ag-idcol">
                    Task
                  </th>
                  <th scope="col">What the agent must do</th>
                </tr>
              </thead>
              <tbody>
                {summary.tasks.map(task => (
                  <tr key={task.id} className="card-row">
                    <th scope="row" className="mono">
                      {task.id}
                    </th>
                    <td className="c-full">
                      <Inline text={task.text} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="sec" aria-labelledby="protocol">
            <h2 id="protocol">The full protocol</h2>
            <p className="ag-intro">
              Every rule above comes from this file. It is frozen once committed; any change is a dated amendment at the
              end.
            </p>
            {/* Compiled on the server from our own protocol file by `compileMarkdown`; not user input. */}
            <div
              data-testid="agents-protocol"
              className="ag-protocol"
              dangerouslySetInnerHTML={{ __html: page.protocol.html }}
            />
          </section>

          <section className="sec" aria-labelledby="library">
            <h2 id="library">Library benchmarks</h2>
            <p className="ag-intro">
              These are separate from the agent benchmark. Each package keeps its numbers, method and raw data in its
              own README.
            </p>
            <p className="mono ag-libline">{libraryLine}</p>
            <details className="ag-more">
              <summary>Show all {packages.length} packages</summary>
              <table aria-label="Library benchmarks" data-testid="agents-library-benchmarks" className="cards">
                <thead>
                  <tr>
                    <th scope="col">Package</th>
                    <th scope="col">Benchmarks</th>
                  </tr>
                </thead>
                <tbody>
                  {packages.map(entry => {
                    const folder = latestSnapshotFolder(entry);
                    return (
                      <tr key={entry.short} className="card-row">
                        <th scope="row">
                          <a href={packageHref(entry.short)} className="mono">
                            {entry.name}
                          </a>
                        </th>
                        <td className="c-end ag-muted">
                          {folder === null || entry.benchStatus === 'none' ? (
                            'No benchmark'
                          ) : (
                            <a href={`${packageDocHref(entry.short, folder, 'README')}#benchmarks`}>
                              README, Benchmarks
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          </section>
        </div>

        <aside className="rail" aria-label="On this page">
          <h2>On this page</h2>
          <ul>
            {RAIL.map(link => (
              <li key={link.id}>
                <a href={`#${link.id}`}>{link.label}</a>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}
