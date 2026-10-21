import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';
import { createFileRoute } from '@tanstack/react-router';

import config from '~/config';
import { getDotNewFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';

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

  return (
    <PageContainer>
      <Shell className="sm:py-8 md:py-12">
        <h1>What dot new writes</h1>
        <p>
          This is the dry-run plan of <code>dot new</code> from <code>@arki/dot</code> {plan.version}, a release
          candidate from the {plan.candidate.wave} wave. Nothing runs in your browser. The page only lists what the
          command would do.
        </p>

        {plan.templates.map(({ template, result }) => {
          const created = result.operations.filter(operation => operation.action === 'create').length;
          return (
            <section key={template} data-testid="dot-new-template" aria-labelledby={`template-${template}`}>
              <h2 id={`template-${template}`}>Template: {template}</h2>
              <p>
                App folder: <code>{result.app.target}</code>. {result.operations.length} files planned, {created} of
                them new.
              </p>

              <h3>Planned files</h3>
              <ul className="m-0 list-none p-0">
                {result.operations.map(operation => (
                  <li
                    key={operation.path}
                    className="border-b border-border py-2 [overflow-wrap:anywhere]"
                    data-testid="dot-new-file"
                  >
                    <code>{operation.path}</code>
                    <span>
                      {' '}
                      — {operation.action}, {operation.contentBytes} bytes
                    </span>
                    <div className="text-sm text-muted-foreground">{operation.reason}</div>
                  </li>
                ))}
              </ul>

              <h3>Next steps</h3>
              <ol>
                {result.nextSteps.map(step => (
                  <li key={step}>
                    <code>{step}</code>
                  </li>
                ))}
              </ol>

              <h3>What you own afterwards</h3>
              <p>
                {created === result.operations.length
                  ? 'Every planned file is new. Once the command finishes, all of them are in your folder and are yours to edit.'
                  : 'Some planned files change files that already exist. Read the action next to each path first.'}
              </p>
            </section>
          );
        })}
      </Shell>
    </PageContainer>
  );
}
