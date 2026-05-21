import { createFileRoute } from '@tanstack/react-router';

import config from '~/config';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/about/')({
  head: () =>
    getDefaultMeta({
      title: `About | ${config.appTitle}`,
      description: `Learn about ${config.appTitle}`,
    }),
  component: AboutPage,
});

function AboutPage() {
  return (
    <main className="mx-auto mt-14 max-w-none px-4 lg:max-w-7xl">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl md:text-6xl">
          Welcome to {config.appTitle}
        </h1>
      </div>
    </main>
  );
}
