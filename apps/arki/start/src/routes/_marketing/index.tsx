import { useRef } from 'react';
import { createFileRoute } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';
import { BuildPath } from '~/shared/marketing/build-path';
import { BUILD_STEPS } from '~/shared/marketing/build-steps';
import { Elevation } from '~/shared/marketing/elevation';
import { GlossaryProvider } from '~/shared/marketing/glossary-term';
import { BuiltWith, Materials, MentalModel, StartHere } from '~/shared/marketing/home-bands';
import { HomeFooter, HomeHeader } from '~/shared/marketing/home-chrome';
import { HeroMark } from '~/shared/marketing/wordmark';
import homeCss from '~/styles/home.css?url';

export const Route = createFileRoute('/_marketing/')({
  head: () => {
    const base = getDefaultMeta({
      title: 'arki — Build from the foundation up.',
      description:
        'Typed TypeScript packages. Dot composes them into one app and the compiler checks the wiring. With the journal nothing writes to a row directly: every change is an event, and a reducer turns it into the row in the same transaction. Six build steps, each with the real code behind it.',
    });
    return {
      ...base,
      links: [...base.links, { rel: 'stylesheet', href: homeCss }],
    };
  },
  component: HomePage,
});

function HomePage() {
  const stage = useRef<HTMLDivElement>(null);

  return (
    <GlossaryProvider>
      <div className="home" ref={stage}>
        <div className="home-wrap">
          <HomeHeader brand="dot" />
          <div className="home-hero">
            <HeroMark />
            <div>
              <p className="home-kicker">
                Construction sequence · {BUILD_STEPS.length} floors ·{' '}
                {BUILD_STEPS.filter(step => step.sheet !== undefined).length} full sheets
              </p>
              <h1>Build from the foundation up.</h1>
              <p>
                Typed TypeScript packages. Dot composes them into one app, and the compiler checks the wiring. With the
                journal nothing writes to a row directly: every change is an event, and a reducer turns it into the row
                in the same transaction. Each floor is one step; the two that matter most come with their own drawing
                sheet.
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
            <Elevation stage={stage} />
          </div>
          <MentalModel />
          <BuiltWith />
          <Materials />
          <StartHere />
          <HomeFooter stage={stage} />
        </div>
      </div>
    </GlossaryProvider>
  );
}
