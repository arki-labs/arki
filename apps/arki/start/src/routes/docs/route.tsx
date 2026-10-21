import { createFileRoute } from '@tanstack/react-router';

import { SiteSectionLayout } from '~/shared/site-nav';

export const Route = createFileRoute('/docs')({
  component: SiteSectionLayout,
});
