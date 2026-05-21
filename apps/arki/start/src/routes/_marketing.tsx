import { createFileRoute, Outlet } from '@tanstack/react-router';

import { MarketingLayout } from '~/shared/marketing/marketing-layout';
import marketingCss from '~/styles/marketing.css?url';

export const Route = createFileRoute('/_marketing')({
  head: () => ({
    links: [{ rel: 'stylesheet', href: marketingCss }],
  }),
  component: MarketingRouteLayout,
});

function MarketingRouteLayout() {
  return (
    <MarketingLayout>
      <Outlet />
    </MarketingLayout>
  );
}
