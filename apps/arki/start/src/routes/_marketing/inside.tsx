import { createFileRoute } from '@tanstack/react-router';

import { InsidePage } from '~/features/inside/inside-page';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/_marketing/inside')({
  head: () =>
    getDefaultMeta({
      title: "What's inside | arki",
      description: 'Every arki and Dot feature, the package it lives in, and the real code that shows it.',
    }),
  component: InsideRoute,
});

function InsideRoute() {
  return <InsidePage />;
}
