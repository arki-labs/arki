import { useRef } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { z } from 'zod';

import { Tokens } from '~/shared/marketing/code';
import { GlossaryProvider } from '~/shared/marketing/glossary-term';
import { tokenizeLines } from '~/shared/marketing/highlight';
import { HomeFooter, HomeHeader } from '~/shared/marketing/home-chrome';
import { HeroMark } from '~/shared/marketing/wordmark';

import '~/styles/inside.css';

import { insideGroups, proofRanges, proofText } from './inside-data';

/** `?show=`: one filter. Any other value, or none, shows every row. */
const insideSearch = z.object({
  show: z.union([z.enum(['new', 'shipped']), z.unknown().transform(() => void 0)]).optional(),
});
type Show = z.infer<typeof insideSearch>['show'];

type Group = (typeof insideGroups)[number];
type Row = Group['rows'][number];

const FILTERS = [
  { label: 'All', show: undefined },
  { label: 'New ideas only', show: 'new' },
  { label: 'Shipped only', show: 'shipped' },
] as const satisfies readonly { label: string; show: Show }[];

const matches = (row: Row, show: Show) => show === undefined || (show === 'new' ? row.new : row.state === 'shipped');

const countNew = (rows: readonly { readonly new: boolean }[]) => rows.filter(row => row.new).length;

function StateIcon({ state }: Readonly<{ state: Row['state'] }>) {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      {state === 'shipped' ? <rect x="0.75" y="0.75" width="8.5" height="8.5" /> : <circle cx="5" cy="5" r="4" />}
      {state === 'candidate' ? <path d="M5 1A4 4 0 0 0 5 9Z" /> : null}
    </svg>
  );
}

function ProofCode({ code }: Readonly<{ code: string }>) {
  return (
    <pre>
      <code>
        {tokenizeLines(code.split('\n')).map((tokens, index) => (
          <span key={index} className="in-ln">
            <Tokens tokens={tokens} />
          </span>
        ))}
      </code>
    </pre>
  );
}

/** "line 9", or "lines 12, 34-39" when there is more than one line. */
const linesLabel = (ranges: readonly string[]) =>
  ranges.length === 1 && !ranges[0]?.includes('-') ? `line ${ranges.join('')}` : `lines ${ranges.join(', ')}`;

function RowView({ row }: Readonly<{ row: Row }>) {
  const { proof } = row;
  const note = 'note' in row ? row.note : undefined;
  return (
    <li className="in-row" data-state={row.state} data-new={row.new}>
      <span className={`in-pill in-pill-${row.state}`}>
        <StateIcon state={row.state} />
        {row.state}
      </span>
      <div className="in-feat">
        {row.new ? (
          <span className="in-newtag">
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 0.5 9.5 9.5H0.5Z" />
            </svg>
            new idea
          </span>
        ) : null}
        <h3>{row.feature}</h3>
      </div>
      <p className="in-what">
        {row.what}
        {note === undefined ? null : <span className="in-note">{note}</span>}
      </p>
      <p className="in-pkg">
        <a href={`/packages/${row.short}`}>@arki/{row.short}</a>
      </p>
      {proof === null ? null : (
        <details className="in-proof">
          <summary>
            <b>{proof.path}</b>
            <span>{linesLabel(proofRanges(proof))}</span>
          </summary>
          <ProofCode code={proofText(proof)} />
        </details>
      )}
    </li>
  );
}

function Sheet({ group, show }: Readonly<{ group: Group; show: Show }>) {
  const shown = group.rows.flatMap(row => (matches(row, show) ? [row] : []));
  return (
    <section className="in-sheet" id={group.sheet} aria-labelledby={`${group.sheet}-title`}>
      <div className="in-tblock">
        <div className="in-no">
          <small>Sheet</small>
          {group.sheet}
        </div>
        <div className="in-tinfo">
          <h2 id={`${group.sheet}-title`}>{group.title}</h2>
          <p className="in-intro">{group.intro}</p>
          <p className="in-count">
            {group.rows.length} rows · {countNew(group.rows)} new ideas
          </p>
        </div>
      </div>
      <div className="in-cols" aria-hidden="true">
        <span>Feature</span>
        <span>What you get</span>
        <span>Package</span>
        <span>State</span>
      </div>
      {shown.length === 0 ? (
        <p className="in-none">No row on this sheet matches the filter.</p>
      ) : (
        <ul className="in-rows">
          {shown.map(row => (
            <RowView key={row.feature} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function InsidePage() {
  const show = insideSearch.parse(useSearch({ strict: false })).show;
  const stage = useRef<HTMLDivElement>(null);
  const rows = insideGroups.flatMap(group => [...group.rows]);
  return (
    <GlossaryProvider>
      <div className="home inside" ref={stage}>
        <div className="home-wrap">
          <HomeHeader current="/inside" brand="dot" />
          <section className="home-hero" aria-labelledby="inside-title">
            <HeroMark />
            <div>
              <p className="home-kicker">
                {insideGroups.length} sheets · {rows.length} rows · {countNew(rows)} new ideas ·{' '}
                {rows.filter(row => row.proof !== null).length} with a code line
              </p>
              <h1 id="inside-title">What's inside</h1>
              <p>
                Every row is one thing arki or Dot does today, with the package it lives in and the line of code that
                shows it.
              </p>
              <ul className="in-legend" aria-label="How to read the states">
                {(
                  [
                    ['shipped', 'on npm now'],
                    ['candidate', 'in the next release'],
                    ['planned', 'on the roadmap'],
                  ] as const
                ).map(([state, meaning]) => (
                  <li key={state}>
                    <span className={`in-pill in-pill-${state}`}>
                      <StateIcon state={state} />
                      {state}
                    </span>
                    {meaning}
                  </li>
                ))}
              </ul>
            </div>
          </section>
          <div className="in-body">
            <div className="in-bar">
              <nav className="in-chips" aria-label="Sheets on this page">
                {insideGroups.map(group => (
                  <a key={group.sheet} href={`#${group.sheet}`}>
                    <b>{group.sheet}</b>
                    {group.title}
                  </a>
                ))}
              </nav>
              <nav className="in-filters" aria-label="Filter rows">
                {FILTERS.map(filter => (
                  <Link
                    key={filter.label}
                    to="/inside"
                    search={{ show: filter.show }}
                    activeOptions={{ exact: true, includeSearch: true }}
                    // An unknown ?show= stays in the URL, so "All" is not the router's active link then; mark it by the parsed filter.
                    inactiveProps={{ 'aria-current': filter.show === show ? 'page' : undefined }}
                    resetScroll={false}
                  >
                    {filter.label}
                  </Link>
                ))}
              </nav>
            </div>
            {insideGroups.map(group => (
              <Sheet key={group.sheet} group={group} show={show} />
            ))}
          </div>
          <HomeFooter stage={stage} current="/inside" />
        </div>
      </div>
    </GlossaryProvider>
  );
}
