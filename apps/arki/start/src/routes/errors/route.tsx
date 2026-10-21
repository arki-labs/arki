import { createFileRoute } from '@tanstack/react-router';

import { siteHead, SiteSectionLayout } from '~/shared/site-chrome';

export const Route = createFileRoute('/errors')({
  head: siteHead,
  component: SiteSectionLayout,
});
