import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';

import { Check, Copy, Files, GitBranch, GithubLogo } from '@arki/icons/phosphor';

import { getDefaultMeta } from '~/shared-metadata';
import homeWipCss from '~/styles/home-wip.css?url';

const REPO = 'https://github.com/arki-dev/arki';
const REPO_LABEL = 'github.com/arki-dev/arki';

export const Route = createFileRoute('/_marketing/')({
  head: () => {
    const base = getDefaultMeta();
    return {
      ...base,
      links: [...base.links, { rel: 'stylesheet', href: homeWipCss }],
    };
  },
  component: HomePage,
});

type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn';

const INSTALLS: Record<PackageManager, string> = {
  bun: 'bun add @arki/dot',
  npm: 'npm install @arki/dot',
  pnpm: 'pnpm add @arki/dot',
  yarn: 'yarn add @arki/dot',
};

function WipInstall() {
  const [pm, setPm] = useState<PackageManager>('bun');
  const [copied, setCopied] = useState(false);

  const doCopy = () => {
    try {
      void navigator.clipboard.writeText(INSTALLS[pm]);
    } catch {
      // clipboard unavailable — silently ignore; the install string is visible
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="wip-cta-row">
      <a className="wip-cta primary" href={REPO} target="_blank" rel="noreferrer">
        <GithubLogo aria-hidden="true" weight="regular" />
        <span>open the repository</span>
        <span className="arr" aria-hidden="true">
          →
        </span>
      </a>

      <div className="wip-cta secondary" role="group" aria-label="Install command">
        <span className="prompt" aria-hidden="true">
          $
        </span>
        <span>{INSTALLS[pm]}</span>
        <button
          type="button"
          className={'copy' + (copied ? ' ok' : '')}
          onClick={doCopy}
          aria-label="Copy install command"
        >
          {copied ? (
            <>
              <Check aria-hidden="true" weight="regular" />
              copied
            </>
          ) : (
            <>
              <Copy aria-hidden="true" weight="regular" />
              copy
            </>
          )}
        </button>
      </div>

      <div role="tablist" aria-label="package manager" className="wip-pm-tabs">
        {(Object.keys(INSTALLS) as PackageManager[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === pm}
            onClick={() => setPm(k)}
          >
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

type ShipCard = {
  title: React.ReactNode;
  description: string;
  meta: string;
};

const SHIP_CARDS: ShipCard[] = [
  {
    title: (
      <>
        <code>defineApp</code> — the kernel
      </>
    ),
    description:
      'A tiny multi-runtime composition root. `.use()` plugins, `.boot()` once, get a fully inferred service graph.',
    meta: '@arki/dot · v0.1.0 · 9.2 KB · zero deps',
  },
  {
    title: <>Package-owned adapters</>,
    description:
      'env · db · kv ship as ready. auth · queue · rpc are on canary. Each owns its own driver matrix and types.',
    meta: '7 packages · 4 ready · 3 canary',
  },
  {
    title: (
      <>
        <code>dot doctor</code> diagnostics
      </>
    ),
    description:
      'Structured failures with a fix URL. `--json` prints the same envelope an agent reads. No magic, no stack-trace dumping.',
    meta: 'dot doctor --json | jq .ok',
  },
];

function WhatShips() {
  return (
    <div className="wip-cols">
      {SHIP_CARDS.map((c, i) => (
        <div className="wip-col" key={i}>
          <div className="ship">
            <span className="gl">●</span>shipping
          </div>
          <div className="ttl">{c.title}</div>
          <div className="desc">{c.description}</div>
          <div className="meta">{c.meta}</div>
        </div>
      ))}
    </div>
  );
}

type RouteStatus = 'ready' | 'canary' | 'alpha' | 'pending';

type RouteRow = {
  route: string;
  status: RouteStatus;
  note: string;
  eta: string;
};

const ROUTES: RouteRow[] = [
  { route: '/', status: 'ready', note: 'you are here — work-in-progress notice', eta: 'shipped' },
  { route: '/docs', status: 'canary', note: 'outline live · draft in packages/dot/README', eta: 'this wk' },
  { route: '/docs/concepts/lifecycle', status: 'canary', note: 'five hooks · diagram + fixture pending', eta: 'this wk' },
  { route: '/docs/concepts/defineApp', status: 'canary', note: 'showcase code written · prose 60%', eta: 'this wk' },
  { route: '/cli/doctor', status: 'alpha', note: 'man-page partial · types in sync', eta: 'next wk' },
  { route: '/packages', status: 'alpha', note: 'catalog stubbed · 7 rows · meta unfilled', eta: 'next wk' },
  { route: '/philosophy', status: 'pending', note: 'outlined in brief · prose not started', eta: '—' },
  { route: '/changelog', status: 'pending', note: 'no tagged releases yet', eta: '—' },
];

function StatusGlyph({ status }: { status: RouteStatus }) {
  const glyph = status === 'canary' ? '◐' : '●';
  if (status === 'pending' || status === 'alpha') {
    return <span className={`st-${status}`}>○</span>;
  }
  return <span className={`st-${status}`}>{glyph}</span>;
}

function StatusLabel({ status }: { status: RouteStatus }) {
  return <span className={`st-${status}`}>{status}</span>;
}

function SiteBoard() {
  const counts = ROUTES.reduce<Record<RouteStatus, number>>(
    (acc, r) => {
      acc[r.status] += 1;
      return acc;
    },
    { ready: 0, canary: 0, alpha: 0, pending: 0 },
  );

  return (
    <div className="wip-board">
      <div className="head">
        <div className="lhs">
          <span className="prompt">$</span>
          <span className="cmd">dot doctor --site --json | jq</span>
        </div>
        <div className="rhs">
          <div className="legend" aria-label="status legend">
            <span>
              <span className="glyph lg-r">●</span>ready
            </span>
            <span>
              <span className="glyph lg-c">◐</span>canary
            </span>
            <span>
              <span className="glyph lg-a">○</span>alpha
            </span>
            <span>
              <span className="glyph lg-p">○</span>pending
            </span>
          </div>
        </div>
      </div>

      <div className="summary">
        <span>
          <b>{ROUTES.length}</b> routes checked
        </span>
        <span className="ok">
          <b>{counts.ready}</b> ready
        </span>
        <span className="cn">
          <b>{counts.canary}</b> canary
        </span>
        <span className="al">
          <b>{counts.alpha}</b> alpha
        </span>
        <span className="pd">
          <b>{counts.pending}</b> pending
        </span>
        <span style={{ marginLeft: 'auto' }}>finished in 11ms</span>
      </div>

      <table>
        <tbody>
          {ROUTES.map((r) => (
            <tr key={r.route}>
              <td className="col-glyph">
                <StatusGlyph status={r.status} />
              </td>
              <td className="col-route">{r.route}</td>
              <td className="col-status">
                <StatusLabel status={r.status} />
              </td>
              <td className="col-note">{r.note}</td>
              <td className="col-eta">{r.eta}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="foot">
        <span className="exit-code">
          exit <span className="ok">2</span> · 6 of 8 routes need work
        </span>
        <span>
          full envelope at{' '}
          <a
            href={`${REPO}/blob/main/apps/arki-dev/dot-doctor-site.json`}
            target="_blank"
            rel="noreferrer"
          >
            apps/arki-dev/dot-doctor-site.json ↗
          </a>
        </span>
      </div>
    </div>
  );
}

function RepoPanel() {
  return (
    <div className="wip-repo">
      <div className="wip-tree">
        <div className="head">
          <span className="repo">{REPO_LABEL}</span>
          <span className="branch">
            <GitBranch aria-hidden="true" weight="regular" style={{ fontSize: 12 }} />
            main · 802cf4e
          </span>
        </div>
        <pre>
          {`arki`}
          <span className="d">/</span>
          {`                         `}
          <span className="note">— monorepo · MIT</span>
          {`\n`}
          <span className="p">├──</span> <span className="b">packages</span>
          <span className="d">/</span>
          {`\n`}
          <span className="p">│   ├──</span> <span className="b">dot</span>
          <span className="d">/</span>
          {`              `}
          <span className="o">● ready</span>
          {`     `}
          <span className="note">the kernel · defineApp · lifecycle</span>
          {`\n`}
          <span className="p">│   ├──</span> <span className="b">env</span>
          <span className="d">/</span>
          {`              `}
          <span className="o">● ready</span>
          {`     `}
          <span className="note">typed env loader · zod schemas</span>
          {`\n`}
          <span className="p">│   ├──</span> <span className="b">db</span>
          <span className="d">/</span>
          {`               `}
          <span className="o">● ready</span>
          {`     `}
          <span className="note">pg · mysql · sqlite</span>
          {`\n`}
          <span className="p">│   ├──</span> <span className="b">kv</span>
          <span className="d">/</span>
          {`               `}
          <span className="o">● ready</span>
          {`     `}
          <span className="note">memory · redis · cf</span>
          {`\n`}
          <span className="p">│   ├──</span> <span className="b">auth</span>
          <span className="d">/</span>
          {`             `}
          <span className="c">◐ canary</span>
          {`    `}
          <span className="note">sessions · jwt · oauth</span>
          {`\n`}
          <span className="p">│   ├──</span> <span className="b">queue</span>
          <span className="d">/</span>
          {`            `}
          <span className="c">◐ canary</span>
          {`    `}
          <span className="note">pg · bullmq · cf</span>
          {`\n`}
          <span className="p">│   └──</span> <span className="b">rpc</span>
          <span className="d">/</span>
          {`              `}
          <span className="c">◐ canary</span>
          {`    `}
          <span className="note">typed client/server</span>
          {`\n`}
          <span className="p">├──</span> <span className="b">apps</span>
          <span className="d">/</span>
          {`\n`}
          <span className="p">│   └──</span> <span className="a">arki-dev</span>
          <span className="d">/</span>
          {`         `}
          <span className="c">◐ this site</span>
          {` `}
          <span className="note">— in flight; you are reading the draft</span>
          {`\n`}
          <span className="p">├──</span> <span className="b">examples</span>
          <span className="d">/</span>
          {`\n`}
          <span className="p">│   ├──</span> <span className="b">billing</span>
          <span className="d">/</span>
          {`          `}
          <span className="o">● ready</span>
          {`     `}
          <span className="note">fixture used in defineApp showcase</span>
          {`\n`}
          <span className="p">│   └──</span> <span className="b">checkout</span>
          <span className="d">/</span>
          {`         `}
          <span className="c">◐ canary</span>
          {`    `}
          <span className="note">queue · webhooks · idempotency</span>
          {`\n`}
          <span className="p">├──</span> README<span className="d">.md</span>
          {`                  `}
          <span className="note">start here</span>
          {`\n`}
          <span className="p">├──</span> llms<span className="d">.txt</span>
          {`                    `}
          <span className="note">agent-readable site map</span>
          {`\n`}
          <span className="p">└──</span> CHANGELOG<span className="d">.md</span>
          {`              `}
          <span className="note">v0.1.0 · 2026-05-12</span>
        </pre>
        <div className="foot">
          <span className="files">
            <Files aria-hidden="true" weight="regular" style={{ fontSize: 12 }} />
            162 files · 7 packages · MIT
          </span>
          <span>last commit · 2 hours ago</span>
        </div>
      </div>

      <aside className="wip-gh" aria-labelledby="gh-h">
        <span className="gh-label">while we wire up the site</span>
        <h3 id="gh-h" className="gh-h">
          the source is canonical<span className="accent">.</span>
        </h3>
        <p className="gh-p">
          The package family ships from this repo. The README is the doctrine, the fixtures are the
          examples, the <code>__fixtures__</code> directories are where every claim on this site
          will eventually link. Read it; clone it; run the tests. No mailing list, no signup.
        </p>

        <div className="gh-actions">
          <a className="wip-gh-btn primary" href={REPO} target="_blank" rel="noreferrer">
            <GithubLogo aria-hidden="true" weight="regular" />
            view on github
          </a>
          <a
            className="wip-gh-btn secondary"
            href={`${REPO}/blob/main/README.md`}
            target="_blank"
            rel="noreferrer"
          >
            README.md ↗
          </a>
          <a
            className="wip-gh-btn secondary"
            href={`${REPO}/blob/main/llms.txt`}
            target="_blank"
            rel="noreferrer"
          >
            llms.txt ↗
          </a>
        </div>

        <div className="gh-stats" aria-label="repository stats">
          <div>
            <span className="gh-stat-v">v0.1.0</span>
            current release
          </div>
          <div>
            <span className="gh-stat-v">7</span>
            packages
          </div>
          <div>
            <span className="gh-stat-v">MIT</span>
            license
          </div>
          <div>
            <span className="gh-stat-v">0</span>
            runtime deps
          </div>
        </div>
      </aside>
    </div>
  );
}

type Commit = {
  hash: string;
  scope: string;
  message: string;
  who: string;
  when: string;
};

const COMMITS: Commit[] = [
  { hash: '802cf4e', scope: 'site', message: 'write work-in-progress notice for the homepage', who: 'rfu', when: '2h' },
  { hash: '4a91d22', scope: 'band', message: 'tune amber phosphor glow on the VT323 retro mark', who: 'rfu', when: '5h' },
  { hash: 'e88f1c2', scope: 'dot', message: 'structured diagnostics envelope · schema v1', who: 'rfu', when: 'Mon' },
  { hash: '31bc004', scope: 'docs', message: 'lifecycle outline · five hooks · diagram pending', who: 'rfu', when: 'Mon' },
  { hash: 'a0e1733', scope: 'example', message: 'billing/defineApp basic fixture committed', who: 'rfu', when: 'Sun' },
  { hash: 'f9c2b18', scope: 'ds', message: 'drop Geist · pin Plex Sans · JetBrains · Fira · VT323', who: 'rfu', when: 'Sun' },
  { hash: '2207ade', scope: 'cli', message: 'dot doctor --json prints structured failures with fix urls', who: 'rfu', when: 'Fri' },
  { hash: '7c44e91', scope: 'pkg', message: 'zero-deps audit · trim 11 KB → 9.2 KB', who: 'rfu', when: 'Fri' },
];

function Journal() {
  return (
    <div className="wip-journal">
      {COMMITS.map((c) => (
        <a
          key={c.hash}
          className="row"
          href={`${REPO}/commit/${c.hash}`}
          target="_blank"
          rel="noreferrer"
        >
          <span className="hash">{c.hash}</span>
          <span className="msg">
            <span className="scope">{c.scope}: </span>
            {c.message}
          </span>
          <span className="who">@{c.who}</span>
          <span className="when">{c.when}</span>
        </a>
      ))}
    </div>
  );
}

function HomePage() {
  return (
    <div className="wip" id="main">
      <section className="wip-hero" aria-labelledby="wip-hero-h">
        <p className="wip-kicker">
          <span className="glyph" aria-hidden="true">
            ◐
          </span>
          <span>site status</span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span className="v">work in progress</span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span>last build 2h ago</span>
        </p>

        <h1 id="wip-hero-h" className="wip-h">
          <span className="dim">the package ships.</span>
          <br />
          this site is still <span className="strike">finished</span> booting
          <span className="dot">.</span>
        </h1>

        <p className="wip-sub">
          <span className="fg">arki.dev</span> is the public surface for the arki package family and
          its application-composition kernel, <code>@arki/dot</code>. The framework is real and on
          npm. The marketing site you&apos;re reading is not done yet. While the docs, CLI man
          pages, and philosophy pages are being written, the source on GitHub is canonical.
        </p>

        <WipInstall />
      </section>

      <section className="wip-section" aria-labelledby="ships-h">
        <header className="wip-section-h">
          <span className="tag">ready</span>
          <span className="title" id="ships-h">
            what ships today
          </span>
          <span className="rule" aria-hidden="true" />
          <span className="meta">three things you can already use</span>
        </header>
        <WhatShips />
      </section>

      <section className="wip-section" aria-labelledby="board-h">
        <header className="wip-section-h">
          <span className="tag">site</span>
          <span className="title" id="board-h">
            the rest of the site, as a build report
          </span>
          <span className="rule" aria-hidden="true" />
          <span className="meta">routes · status · note</span>
        </header>
        <SiteBoard />
      </section>

      <section className="wip-section" aria-labelledby="repo-h">
        <header className="wip-section-h">
          <span className="tag">source</span>
          <span className="title" id="repo-h">
            where the docs actually live
          </span>
          <span className="rule" aria-hidden="true" />
          <span className="meta">github · MIT</span>
        </header>
        <RepoPanel />
      </section>

      <section className="wip-section" aria-labelledby="journal-h" style={{ marginBottom: 16 }}>
        <header className="wip-section-h">
          <span className="tag">journal</span>
          <span className="title" id="journal-h">
            recent commits
          </span>
          <span className="rule" aria-hidden="true" />
          <span className="meta">
            <a href={`${REPO}/commits/main`} target="_blank" rel="noreferrer">
              full log on github ↗
            </a>
          </span>
        </header>
        <Journal />
      </section>
    </div>
  );
}
