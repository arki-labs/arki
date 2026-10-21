import { createFileRoute } from '@tanstack/react-router';

import { siteHead, SiteSectionLayout } from '~/shared/site-chrome';

export const Route = createFileRoute('/packages')({
  head: siteHead,
  component: SiteSectionLayout,
});
