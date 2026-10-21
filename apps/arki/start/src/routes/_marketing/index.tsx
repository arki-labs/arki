import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';
import { BuildPath } from '~/shared/marketing/build-path';
import { BUILD_STEPS } from '~/shared/marketing/build-steps';
import { Elevation } from '~/shared/marketing/elevation';
import { GlossaryProvider } from '~/shared/marketing/glossary-term';
import { BuiltWith, Materials, StartHere } from '~/shared/marketing/home-bands';
import { ModeSwitch } from '~/shared/marketing/mode-switch';
import { HeroMark, Wordmark } from '~/shared/marketing/wordmark';
import homeCss from '~/styles/home.css?url';

const REPO = 'https://github.com/arki-labs/arki';

/** The header leads to the two places most readers want; the footer keeps the rest within reach. */
const SITE_LINKS = [
  { label: 'Docs', href: '/docs' },
  { label: 'Packages', href: '/packages' },
] as const;

const MORE_LINKS = [
  { label: 'Errors', href: '/errors' },
  { label: 'Compare', href: '/compare' },
] as const;

export const Route = createFileRoute('/_marketing/')({
  head: () => {
    const base = getDefaultMeta({
      title: 'arki — Build from the foundation up.',
      description:
        'Typed TypeScript packages that compose into one app. The compiler checks the wiring, Postgres keeps the history. Six build steps, each with the real code behind it.',
    });
    return {
      ...base,
      links: [...base.links, { rel: 'stylesheet', href: homeCss }],
    };
  },
  component: HomePage,
});

/** The nearest ancestor that scrolls. On this site the page scrolls inside `.marketing`, not in the window. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** Where, as a share of the view, a floor counts as the one being read. */
const READING_LINE = 0.4;

/**
 * The floor whose section has reached the reading line, or -1 until the first one does. It is worked out from the
 * scroll position of the element that really scrolls, not from an IntersectionObserver: that one's `rootMargin` is
 * ignored inside a cross-origin frame and depends on which element is the root, and a lit floor must not hinge on it.
 */
function useActiveFloor(stage: RefObject<HTMLElement | null>): number {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const home = stage.current;
    if (home === null) return;
    const scroller = scrollParent(home);
    const target: HTMLElement | Window = scroller ?? window;
    const sections = [...home.querySelectorAll<HTMLElement>('[data-floor]')];
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller?.getBoundingClientRect().top ?? 0;
      const height = scroller?.clientHeight ?? window.innerHeight;
      const line = top + height * READING_LINE;
      let floor = -1;
      for (const [index, section] of sections.entries()) {
        if (section.getBoundingClientRect().top <= line) floor = index;
      }
      setActive(floor);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    target.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [stage]);
  return active;
}

function HomePage() {
  const stage = useRef<HTMLDivElement>(null);
  const active = useActiveFloor(stage);

  return (
    <GlossaryProvider>
      <div className="home" ref={stage}>
        <div className="home-wrap">
          <header className="home-bar">
            <a className="home-brand" href="/" aria-label="arki home">
              <Wordmark />
            </a>
            <nav className="home-nav" aria-label="Main navigation">
              {SITE_LINKS.map(link => (
                <a key={link.href} href={link.href}>
                  {link.label}
                </a>
              ))}
              <a href={REPO} target="_blank" rel="noreferrer">
                GitHub
              </a>
            </nav>
          </header>
          <div className="home-hero">
            <HeroMark />
            <div>
              <p className="home-kicker">
                Construction sequence · {BUILD_STEPS.length} floors ·{' '}
                {BUILD_STEPS.filter(step => step.sheet !== undefined).length} full sheets
              </p>
              <h1>Build from the foundation up.</h1>
              <p>
                Typed TypeScript packages that compose into one app. The compiler checks the wiring. Postgres keeps the
                history. Each floor is one step; the two that matter most come with their own drawing sheet.
              </p>
              <code className="home-install">bun add @arki/dot</code>
              <div className="home-links">
                <a href="/docs">Read the docs</a>
                <a href="/packages">All packages</a>
              </div>
            </div>
          </div>
          <div className="home-grid">
            <BuildPath />
            <Elevation active={active} />
          </div>
          <BuiltWith />
          <Materials />
          <StartHere />
          <footer className="home-foot">
            <a className="home-brand" href="/" aria-label="arki home">
              <Wordmark />
            </a>
            <span>Each code line is copied from the named file.</span>
            <nav aria-label="Footer navigation">
              {SITE_LINKS.map(link => (
                <a key={link.href} href={link.href}>
                  {link.label}
                </a>
              ))}
              <a href={REPO} target="_blank" rel="noreferrer">
                GitHub
              </a>
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
        </div>
      </div>
    </GlossaryProvider>
  );
}
