import { createFileRoute, Link } from '@tanstack/react-router';

import config from '~/config';
import { getDotNewFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';
import { CodeBlock, Pill } from '~/shared/site-chrome';
import {
  DEFAULT_TEMPLATE,
  defaultFirst,
  fileReason,
  formatBytes,
  formatPlanDate,
  newCommand,
  summarizeOperations,
} from './-dot-new-plan';

export const Route = createFileRoute('/docs/dot-new')({
  loader: () => getDotNewFn(),
  head: () =>
    getDefaultMeta({
      title: `What dot new writes | ${config.appTitle}`,
      description: 'The files each dot new template plans to create, before you run anything.',
    }),
  component: DotNewPage,
});

function DotNewPage() {
  const plan = Route.useLoaderData();
  const templates = defaultFirst(plan.templates).map(({ template, result }) => ({
    template,
    result,
    ...summarizeOperations(result.operations),
    isDefault: template === DEFAULT_TEMPLATE,
    command: newCommand(template, result.app.target),
  }));
  const dryRunTarget = templates[0]?.result.app.target ?? 'my-app';

  return (
    <>
      <main id="content">
        <article className="dn-article">
          <nav aria-label="Breadcrumb" className="dn-crumb">
            <Link to="/docs">Docs</Link> <span aria-hidden="true">/</span>{' '}
            <span aria-current="page">What dot new writes</span>
          </nav>
          <h1 className="dn-h1">What dot new writes</h1>
          <p className="dn-lead">
            Every file <code>dot new</code> creates, before you run anything. Nothing runs in your browser: this is the
            command&apos;s own dry-run plan.
          </p>
          <p className="mono dn-from">
            <Pill kind="st-next" glyph="◐">
              next
            </Pill>{' '}
            from @arki/dot {plan.version} · release candidate, commit {plan.candidate.sourceCommit.slice(0, 7)},{' '}
            {formatPlanDate(plan.candidate.createdAt)}
          </p>

          <ul className="dn-pick">
            {templates.map(entry => (
              <li key={entry.template}>
                <a href={`#template-${entry.template}`}>
                  <span className="mono dn-pick-name">{entry.template}</span>{' '}
                  <span className="mono dn-pick-tag">{entry.isDefault ? 'default' : ''}</span>
                  <span className="mono dn-pick-count">
                    {entry.files} files, {entry.size}
                  </span>
                </a>
              </li>
            ))}
          </ul>

          <CodeBlock
            head="Get this plan yourself, as JSON"
            code={`dot new ${dryRunTarget} --dry-run --json`}
            label="Dry-run command"
            copyLabel="Copy the dry-run command"
          />

          {templates.map(entry => (
            <section key={entry.template} data-testid="dot-new-template" aria-labelledby={`template-${entry.template}`}>
              <h2 id={`template-${entry.template}`}>
                Template: <span className="mono dn-name">{entry.template}</span>{' '}
                <span className="mono dn-tag">{entry.isDefault ? 'default' : ''}</span>
              </h2>
              <p className="dn-facts">
                App folder <code>{entry.result.app.target}/</code> · {entry.files} files, {entry.size} ·{' '}
                {entry.ownership}
              </p>
              <CodeBlock
                head="Run"
                code={entry.command}
                label={`Command for the ${entry.template} template`}
                copyLabel={`Copy the ${entry.template} command`}
              />

              <h3>Planned files</h3>
              <table className="cards" aria-label={`Files the ${entry.template} template creates`}>
                <thead>
                  <tr>
                    <th scope="col">Path</th>
                    <th scope="col" className="dn-size-head">
                      Size
                    </th>
                    <th scope="col" className="dn-why-head">
                      What it is
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entry.result.operations.map(operation => (
                    <tr key={operation.path} className="card-row" data-testid="dot-new-file">
                      <th scope="row" className="dn-path">
                        {operation.path}
                      </th>
                      <td className="c-end dn-size">{formatBytes(operation.contentBytes)}</td>
                      <td className="c-full dn-why">{fileReason(operation.reason)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3>Next steps</h3>
              <CodeBlock
                head={`${entry.result.nextSteps.length} commands, in order`}
                code={entry.result.nextSteps.join('\n')}
                label={`Next steps for the ${entry.template} template`}
                copyLabel={`Copy the ${entry.template} next steps`}
              />
            </section>
          ))}
        </article>
      </main>

      <aside className="rail" aria-label="On this page">
        <h2>On this page</h2>
        <ul>
          {templates.map(entry => (
            <li key={entry.template}>
              <a href={`#template-${entry.template}`}>Template: {entry.template}</a>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
