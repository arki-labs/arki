import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from '@tanstack/react-router';

import { DOC_JOBS } from '~/routes/docs/-doc-jobs';
import siteCss from '~/styles/site.css?url';

/**
 * Shared chrome of the reference pages (docs, packages, errors, agents, compare), ported from the approved Claude
 * Design canvases. Styles live in `~/styles/site.css` under the `.site` root; every export names the canvas class it
 * mirrors. Pages render their own `<main id="content">` (and an optional `<aside className="rail">`) inside the layout.
 */

/** Route `head` for a section layout: loads `site.css`. */
export const siteHead = () => ({ links: [{ rel: 'stylesheet', href: siteCss }] });

const MAIN_LINKS = [
  { to: '/docs', label: 'Docs' },
  { to: '/packages', label: 'Packages' },
  { to: '/inside', label: "What's inside" },
  { to: '/agents', label: 'Agents' },
] as const;

function MainLinks() {
  return (
    <>
      {MAIN_LINKS.map(link => (
        <Link key={link.to} to={link.to} className="nav-link">
          {link.label}
        </Link>
      ))}
    </>
  );
}

/**
 * Canvas `header` (56px). Wordmark, `nav[aria-label=Main]` (`.top-links`, `.nav-link`; TanStack `Link` sets
 * `aria-current="page"` on the active section by prefix), `llms.txt` (`.top-tools`), and the no-JS `details.mnav` menu
 * under 768px. There is no search button: the app has no search.
 */
export function SiteHeader() {
  return (
    <header className="site-head">
      <div className="bar">
        <Link to="/" className="wordmark">
          <img
            className="brand-wordmark brand-wordmark-light"
            src="/brand/arki-mineral.svg"
            alt="arki"
            width={120}
            height={65}
          />
          <img
            className="brand-wordmark brand-wordmark-dark"
            src="/brand/arki-signal.svg"
            alt=""
            width={120}
            height={65}
          />
        </Link>
        <nav aria-label="Main" className="top-links">
          <MainLinks />
        </nav>
        <div className="top-tools">
          <a className="nav-link mono" href="/llms.txt" style={{ fontSize: 13 }}>
            llms.txt
          </a>
        </div>
        <details className="mnav">
          <summary>Menu</summary>
          <nav aria-label="Main">
            <MainLinks />
            <a className="nav-link mono" href="/llms.txt">
              llms.txt
            </a>
          </nav>
        </details>
      </div>
    </header>
  );
}

/** The band's three rows. A `pulse` part is a lit dot; its class sets the animation delay. */
const BAND_ROWS = [
  [
    {
      text: '·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·',
    },
  ],
  [
    { text: '  ·   ·   ·   ' },
    { text: 'o', pulse: 'p' },
    { text: '   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ' },
    { text: 'o', pulse: 'p p2' },
    { text: '   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ' },
    { text: 'o', pulse: 'p p3' },
    { text: '   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·' },
  ],
  [
    { text: '·   ·   ·   ·   ·   ·   ·   ·   ' },
    { text: 'o', pulse: 'p p3' },
    { text: '   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ' },
    { text: 'o', pulse: 'p' },
    { text: '   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ' },
    { text: 'o', pulse: 'p p2' },
    { text: '   ·   ·   ·   ·' },
  ],
] as const;

/** Canvas idle band (`.band`, `.p`, `.p2`, `.p3`): decorative ASCII dots; static under `prefers-reduced-motion`. */
export function IdleBand() {
  return (
    <div aria-hidden="true" className="band">
      <pre className="mono">
        {BAND_ROWS.map((row, rowIndex) => (
          <span key={rowIndex}>
            {rowIndex > 0 ? '\n' : null}
            {row.map((part, partIndex) =>
              'pulse' in part ? (
                <span key={partIndex} className={part.pulse}>
                  {part.text}
                </span>
              ) : (
                part.text
              ),
            )}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** Canvas `footer` (`.foot`): mono status bar with the site name, the current pathname and `llms.txt`. */
export function SiteFooter() {
  const { pathname } = useLocation();
  return (
    <footer className="foot mono">
      <div className="bar">
        <span>arki.dev</span>
        <span>{pathname}</span>
        <a href="/llms.txt">llms.txt</a>
      </div>
    </footer>
  );
}

const REFERENCE_LINKS = [
  { to: '/docs/guides', label: 'Guides' },
  { to: '/docs/glossary', label: 'Glossary' },
  { to: '/packages', label: 'Packages' },
  { to: '/errors', label: 'Error codes' },
] as const;

/**
 * Canvas `nav.side` (`.side`, `.side-title`, `.side-link`): "Tasks" (the five jobs of `-doc-jobs.ts`, linking
 * `/docs#<id>`) then "Reference". Hidden under 768px (the header menu covers it). `aria-current` marks the Reference
 * link of the current page.
 */
export function DocsSidebar() {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Docs" className="side">
      <div className="side-title">Tasks</div>
      {DOC_JOBS.map(job => (
        <Link key={job.id} to="/docs" hash={job.id} className="side-link" activeOptions={{ includeHash: true }}>
          {job.title}
        </Link>
      ))}
      <div className="side-title">Reference</div>
      {REFERENCE_LINKS.map(link => (
        <Link
          key={link.to}
          to={link.to}
          className="side-link"
          aria-current={pathname === link.to || pathname.startsWith(`${link.to}/`) ? 'page' : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/** Canvas `.copy` button: copies `text`, shows Copied or Failed for two seconds. 44px touch target under 768px. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <button type="button" className="copy" aria-label={label} onClick={() => void copy()}>
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}</span>
    </button>
  );
}

/**
 * Canvas `.codebox` (floating copy button) or, when `head` is given, `.code` + `.code-head` (a head row with the file
 * name and the copy button). `label` is the `aria-label` of the focusable `<pre>`; `copyLabel` that of the button.
 */
export function CodeBlock({
  code,
  label,
  head,
  copyLabel,
}: {
  code: string;
  label: string;
  head?: string;
  copyLabel: string;
}) {
  const body = (
    // A scrollable region must take keyboard focus so long lines can be read without a mouse.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <pre tabIndex={0} aria-label={label}>
      <code>{code}</code>
    </pre>
  );
  if (head === undefined) {
    return (
      <div className="codebox">
        {body}
        <CopyButton text={code} label={copyLabel} />
      </div>
    );
  }
  return (
    <div className="code">
      <div className="code-head">
        <span className="mono">{head}</span>
        <CopyButton text={code} label={copyLabel} />
      </div>
      {body}
    </div>
  );
}

type PillKind =
  | 'st-ok'
  | 'st-published'
  | 'st-next'
  | 'st-archive'
  | 'st-none'
  | 'st-muted'
  | 'st-warn'
  | 'st-bad'
  | 'k-thrown'
  | 'k-failure';

/** Canvas `.pill` + status modifier (`kind`, one of the `st-*` / `k-*` classes). `glyph` is decorative (`aria-hidden`). */
export function Pill({ kind, glyph, children }: { kind: PillKind; glyph: string; children: ReactNode }) {
  return (
    <span className={`pill ${kind}`}>
      <span aria-hidden="true">{glyph}</span>
      {children}
    </span>
  );
}

function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="site">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <SiteHeader />
      {children}
      <IdleBand />
      <SiteFooter />
    </div>
  );
}

/** Layout of `packages`, `errors`, `compare` and `agents`: skip link, header, the page, band, footer. */
export function SiteSectionLayout() {
  return (
    <SiteShell>
      <Outlet />
    </SiteShell>
  );
}

/** Layout of `docs`: like `SiteSectionLayout`, but the page sits in a flex row after `DocsSidebar` (`.docs-row`). */
export function DocsSectionLayout() {
  return (
    <SiteShell>
      <div className="docs-row">
        <DocsSidebar />
        <Outlet />
      </div>
    </SiteShell>
  );
}
