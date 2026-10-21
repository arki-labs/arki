import { createFileRoute, Link } from '@tanstack/react-router';

import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import config from '~/config';
import type { ArkiCell } from '~/features/compare/compare-data';
import {
  adoptingDotCosts,
  chooseSomethingElse,
  compareRows,
  OTHER_FRAMEWORKS,
} from '~/features/compare/compare-data';
import { packageHref } from '~/features/site-data/package-urls';
import { listPackagesFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/compare/')({
  loader: () => listPackagesFn(),
  head: () =>
    getDefaultMeta({
      title: `Compare Arki with Laravel, Rails and AdonisJS | ${config.appTitle}`,
      description: 'What each framework ships, and what Arki has shipped, planned or ruled out.',
    }),
  component: ComparePage,
});

function ArkiCellView({ cell, statusByShort }: { cell: ArkiCell; statusByShort: ReadonlyMap<string, string> }) {
  if (cell.state === 'shipped') {
    return (
      <div data-cell="shipped">
        <strong>Shipped. </strong>
        <a href={packageHref(cell.short)}>@arki/{cell.short}</a>
        <span> ({statusByShort.get(cell.short) ?? 'listed'})</span>
      </div>
    );
  }
  if (cell.state === 'planned') {
    return (
      <div data-cell="planned">
        <strong>Planned. </strong>
        <span>Release wave: {cell.wave}.</span>
      </div>
    );
  }
  return (
    <div data-cell="not-planned">
      <strong>Not planned. </strong>
      <span>{cell.reason}</span>
    </div>
  );
}

const statusLabel = {
  next: 'release candidate',
  published: 'published',
  archive: 'published, README only',
  none: 'no docs yet',
} as const;

function ComparePage() {
  const packages = Route.useLoaderData();
  const statusByShort = new Map(packages.map(entry => [entry.short, statusLabel[entry.status]]));

  return (
    <PageContainer>
      <Shell className="sm:py-8 md:py-12">
        <h1>Arki compared with Laravel, Rails and AdonisJS</h1>
        <p>
          Each row is a feature. The Arki cell is one of three things: shipped, planned or not planned. Every
          shipped cell links to its package page.
        </p>

        {/* Rows are cards, not a wide table: nothing scrolls sideways on a phone. */}
        <ul className="m-0 list-none p-0" data-testid="compare-rows">
          {compareRows.map(row => (
            <li key={row.feature} data-testid="compare-row" className="border-border grid gap-2 border-b py-4 md:grid-cols-5">
              <h2 className="text-base font-semibold">{row.feature}</h2>
              {OTHER_FRAMEWORKS.map(framework => (
                <div key={framework.id}>
                  <div className="text-muted-foreground text-sm">{framework.name}</div>
                  <div>{row[framework.id]}</div>
                </div>
              ))}
              <div>
                <div className="text-muted-foreground text-sm">Arki</div>
                <ArkiCellView cell={row.arki} statusByShort={statusByShort} />
              </div>
            </li>
          ))}
        </ul>

        <section aria-labelledby="choose-else">
          <h2 id="choose-else">Choose something else when…</h2>
          <ul>
            {chooseSomethingElse.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="dot-cost">
          <h2 id="dot-cost">What adopting Dot costs</h2>
          <ul>
            {adoptingDotCosts.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>
            <Link to="/docs/dot-new">See exactly what dot new writes</Link>
          </p>
        </section>
      </Shell>
    </PageContainer>
  );
}
