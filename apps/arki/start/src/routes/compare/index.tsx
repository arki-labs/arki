import { createFileRoute, Link } from '@tanstack/react-router';

import type { ArkiCell } from '~/features/compare/compare-data';
import config from '~/config';
import { adoptingDotCosts, chooseSomethingElse, compareRows, OTHER_FRAMEWORKS } from '~/features/compare/compare-data';
import { packageHref } from '~/features/site-data/package-urls';
import { listPackagesFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';
import { Pill } from '~/shared/site-chrome';

export const Route = createFileRoute('/compare/')({
  loader: () => listPackagesFn(),
  head: () =>
    getDefaultMeta({
      title: `Compare Arki with Laravel, Rails and AdonisJS | ${config.appTitle}`,
      description: 'What each framework ships, and what Arki has shipped, planned or ruled out.',
    }),
  component: ComparePage,
});

/** The package status vocabulary of /packages: a glyph, a label and the pill colour. */
const PACKAGE_STATUS = {
  next: { glyph: '◐', label: 'next', kind: 'st-next' },
  archive: { glyph: '▪', label: 'archive', kind: 'st-archive' },
  published: { glyph: '●', label: 'published', kind: 'st-published' },
  none: { glyph: '–', label: 'no docs yet', kind: 'st-none' },
} as const;

type PackageStatus = keyof typeof PACKAGE_STATUS;

const ARKI_STATES = [
  { state: 'shipped', glyph: '✓', label: 'shipped', group: 'Shipped' },
  { state: 'planned', glyph: '○', label: 'planned', group: 'Planned' },
  { state: 'not-planned', glyph: '–', label: 'not planned', group: 'Not planned' },
] as const;

function State({ state }: { state: ArkiCell['state'] }) {
  const entry = ARKI_STATES.find(candidate => candidate.state === state);
  return (
    <span className={`cmp-state cmp-${state}`}>
      <span aria-hidden="true">{entry?.glyph}</span>
      {entry?.label}
    </span>
  );
}

function ArkiCellView({ cell, statusByShort }: { cell: ArkiCell; statusByShort: ReadonlyMap<string, PackageStatus> }) {
  if (cell.state === 'shipped') {
    const status = PACKAGE_STATUS[statusByShort.get(cell.short) ?? 'none'];
    return (
      <div data-cell="shipped" className="cmp-ship">
        <State state="shipped" />
        <a href={packageHref(cell.short)} className="mono">
          @arki/{cell.short}
        </a>
        <Pill kind={status.kind} glyph={status.glyph}>
          {status.label}
        </Pill>
      </div>
    );
  }
  if (cell.state === 'planned') {
    return (
      <div data-cell="planned">
        <State state="planned" />{' '}
        <span className="cmp-note">
          release wave <span className="mono cmp-wave">{cell.wave}</span>
        </span>
      </div>
    );
  }
  return (
    <div data-cell="not-planned">
      <State state="not-planned" />
      <div className="cmp-reason">{cell.reason}</div>
    </div>
  );
}

function ComparePage() {
  const packages = Route.useLoaderData();
  const statusByShort = new Map<string, PackageStatus>(packages.map(entry => [entry.short, entry.status]));
  const groups = ARKI_STATES.map(entry => ({
    ...entry,
    rows: compareRows.filter(row => row.arki.state === entry.state),
  })).filter(group => group.rows.length > 0);

  return (
    <main id="content" className="cmp-main">
      <h1 className="cmp-h1">Arki compared with Laravel, Rails and AdonisJS</h1>
      <p className="cmp-lead">
        Each row is a feature. The Arki cell is one of three things: shipped, planned or not planned. Every shipped cell
        links to its package page and shows where that package stands today.
      </p>
      <p className="cmp-legend">
        {ARKI_STATES.map(entry => (
          <span key={entry.state} className={`cmp-state cmp-${entry.state}`}>
            <span aria-hidden="true">{entry.glyph}</span>
            {entry.label}{' '}
            <span className="cmp-count">{compareRows.filter(row => row.arki.state === entry.state).length}</span>
          </span>
        ))}
      </p>

      {/* Rows turn into cards at 767px and below, so nothing scrolls sideways on a phone. */}
      <table className="cmp" aria-label="Features by framework" data-testid="compare-rows">
        <colgroup>
          <col className="cmp-col-feature" />
          {OTHER_FRAMEWORKS.map(framework => (
            <col key={framework.id} className="cmp-col-other" />
          ))}
          <col className="cmp-col-arki" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Feature</th>
            {OTHER_FRAMEWORKS.map(framework => (
              <th key={framework.id} scope="col">
                {framework.name}
              </th>
            ))}
            <th scope="col" className="cmp-arki-head">
              Arki
            </th>
          </tr>
        </thead>
        {groups.map(group => (
          <tbody key={group.state}>
            <tr>
              <th scope="rowgroup" colSpan={5} className="cmp-group">
                {group.group} · {group.rows.length}
              </th>
            </tr>
            {group.rows.map(row => (
              <tr key={row.feature} className="cmp-row" data-testid="compare-row">
                <th scope="row" className="cmp-feature">
                  {row.feature}
                </th>
                {OTHER_FRAMEWORKS.map(framework => (
                  <td key={framework.id} className="cmp-other">
                    <span className="lbl">{framework.name}</span>
                    {row[framework.id]}
                  </td>
                ))}
                <td className="cmp-arki">
                  <span className="lbl">Arki</span>
                  <ArkiCellView cell={row.arki} statusByShort={statusByShort} />
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>

      <section className="cmp-sec" aria-labelledby="choose-else">
        <h2 id="choose-else">Choose something else when…</h2>
        <ul>
          {chooseSomethingElse.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="cmp-sec" aria-labelledby="dot-cost">
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
    </main>
  );
}
