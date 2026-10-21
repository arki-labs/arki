import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createFileRoute } from '@tanstack/react-router';

import { cn } from '@arki/ui/cn';

import type { CodeKind } from '~/shared/marketing/floors';
import { getDefaultMeta } from '~/shared-metadata';
import { Elevation } from '~/shared/marketing/elevation';
import { FLOORS } from '~/shared/marketing/floors';
import { ModeSwitch } from '~/shared/marketing/mode-switch';
import { HeroMark, Wordmark } from '~/shared/marketing/wordmark';
import homeCss from '~/styles/home.css?url';

const REPO = 'https://github.com/arki-labs/arki';

const SITE_LINKS = [
  { label: 'Docs', href: '/docs' },
  { label: 'Packages', href: '/packages' },
  { label: 'Errors', href: '/errors' },
  { label: 'Compare', href: '/compare' },
] as const;

const CODE_CLASS = {
  plain: undefined,
  keyword: 'home-k',
  fn: 'home-f',
  comment: 'home-c',
} as const satisfies Record<CodeKind, string | undefined>;

export const Route = createFileRoute('/_marketing/')({
  head: () => {
    const base = getDefaultMeta({
      title: 'arki — Build from the foundation up.',
      description:
        'A TypeScript application framework in six floors: validation first, then the Dot kernel, infrastructure, a React interface, money and local-first AI. Stop at any floor.',
    });
    return {
      ...base,
      links: [...base.links, { rel: 'stylesheet', href: homeCss }],
    };
  },
  component: HomePage,
});

/** The floor whose section sits at the reading line, or -1 until the first one is reached. */
function useActiveFloor(): number {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
          const floor = Number(entry.target.dataset.floor);
          if (Number.isInteger(floor)) setActive(floor);
        }
      },
      { rootMargin: '-38% 0px -52% 0px' },
    );
    for (const section of document.querySelectorAll('[data-floor]')) observer.observe(section);
    return () => observer.disconnect();
  }, []);
  return active;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Motion is on until the reader pauses it, or asks the system for less motion. */
function useMotion() {
  const [userPaused, setUserPaused] = useState(false);
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
  return { paused: userPaused || reduced, toggle: () => setUserPaused(previous => !previous) };
}

function HomePage() {
  const active = useActiveFloor();
  const motion = useMotion();
  const stage = useRef<HTMLDivElement>(null);

  return (
    <div className="home" ref={stage} data-motion={motion.paused ? 'paused' : 'on'}>
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
          </nav>
          <div className="home-tools">
            <ModeSwitch stage={stage} animate={!motion.paused} />
            <button className="home-btn" type="button" aria-pressed={motion.paused} onClick={motion.toggle}>
              {motion.paused ? 'Resume motion' : 'Pause motion'}
            </button>
          </div>
        </header>
        <div className="home-hero">
          <HeroMark />
          <div>
            <p className="home-kicker">Construction sequence · {FLOORS.length} floors</p>
            <h1>Build from the foundation up.</h1>
            <p>
              Start with validation and typed failures. Add Dot when you need an app. Every floor depends only on the
              floors below it, so you can stop at any floor.
            </p>
            <code className="home-install">bun add @arki/dot</code>
            <div className="home-links">
              <a href="/docs">Read the docs</a>
              <a href="/packages">All packages</a>
              <a href="/compare">Compare</a>
            </div>
          </div>
        </div>
        <div className="home-grid">
          <div className="home-steps">
            {FLOORS.map((floor, index) => (
              <section
                key={floor.name}
                className={cn('home-step', index === active && 'is-now')}
                data-floor={index}
                aria-labelledby={`floor-${index + 1}`}
              >
                <p className="home-kicker">
                  <b>{`W${index + 1}`}</b> · {floor.name} · {floor.packages.length} packages
                </p>
                <h2 id={`floor-${index + 1}`}>{floor.title}</h2>
                <p className="home-step-text">{floor.text}</p>
                <figure className="home-code">
                  <figcaption>{floor.readme} · Quick start</figcaption>
                  <pre>
                    <code>
                      {floor.code.map((line, row) => (
                        <span className="home-code-line" key={row}>
                          {line.map(([kind, text], column) => (
                            <span key={column} className={CODE_CLASS[kind]}>
                              {text}
                            </span>
                          ))}
                        </span>
                      ))}
                    </code>
                  </pre>
                </figure>
                <ul className="home-packages" aria-label={`${floor.name} packages`}>
                  {floor.packages.map(name => (
                    <li key={name}>@arki/{name}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <Elevation active={active} />
        </div>
        <footer className="home-foot">
          <a className="home-brand" href="/" aria-label="arki home">
            <Wordmark />
          </a>
          <span>Each code line is copied from the named README.</span>
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
        </footer>
      </div>
    </div>
  );
}
