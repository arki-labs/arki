import { createFileRoute } from '@tanstack/react-router';

import { DocsSectionLayout, siteHead } from '~/shared/site-chrome';

export const Route = createFileRoute('/docs')({
  head: siteHead,
  component: DocsSectionLayout,
});
