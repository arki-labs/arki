import type { RefObject } from 'react';

import { ModeSwitch } from './mode-switch';
import { Wordmark } from './wordmark';

const REPO = 'https://github.com/arki-labs/arki';

/** The header leads to the places most readers want; the footer keeps the rest within reach. */
const SITE_LINKS = [
  { label: 'Docs', href: '/docs' },
  { label: 'Packages', href: '/packages' },
  { label: "What's inside", href: '/inside' },
] as const;

const MORE_LINKS = [
  { label: 'Errors', href: '/errors' },
  { label: 'Compare', href: '/compare' },
] as const;

type SiteHref = (typeof SITE_LINKS)[number]['href'];

function SiteLinks({ current }: Readonly<{ current?: SiteHref }>) {
  return (
    <>
      {SITE_LINKS.map(link => (
        <a key={link.href} href={link.href} aria-current={link.href === current ? 'page' : undefined}>
          {link.label}
        </a>
      ))}
      <a href={REPO} target="_blank" rel="noreferrer">
        GitHub
      </a>
    </>
  );
}

/** The wordmark and the main links, shared by the homepage and the pages that wear its frame. */
export function HomeHeader({ current }: Readonly<{ current?: SiteHref }>) {
  return (
    <header className="home-bar">
      <a className="home-brand" href="/" aria-label="arki home">
        <Wordmark />
      </a>
      <nav className="home-nav" aria-label="Main navigation">
        <SiteLinks current={current} />
      </nav>
    </header>
  );
}

/** The closing strip: links, the four-swatch theme picker for the `stage` element, and the lesser pages. */
export function HomeFooter({ stage, current }: Readonly<{ stage: RefObject<HTMLElement | null>; current?: SiteHref }>) {
  return (
    <footer className="home-foot">
      <a className="home-brand" href="/" aria-label="arki home">
        <Wordmark />
      </a>
      <span>Each code line is copied from the named file.</span>
      <nav aria-label="Footer navigation">
        <SiteLinks current={current} />
      </nav>
      <ModeSwitch stage={stage} />
      <nav className="home-more" aria-label="More pages">
        {MORE_LINKS.map(link => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
