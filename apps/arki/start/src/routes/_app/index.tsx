import { createFileRoute } from '@tanstack/react-router';

import { ComingSoon } from '@arki/sitekit/components/coming-soon';
import { PageContainer } from '@arki/sitekit/layout/workspace/page-container.tsx';

import config from '~/config';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/_app/')({
  head: () => getDefaultMeta(),
  component: HomePage,
});

function HomePage() {
  return (
    <PageContainer>
      <h1 className="text-5xl font-extrabold tracking-tight sm:text-[5rem]">{config.appTitle.toUpperCase()}</h1>
      <ComingSoon />
    </PageContainer>
  );
}
