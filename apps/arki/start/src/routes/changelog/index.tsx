import { createFileRoute } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';

import { ChangelogTimeline } from '@arki/content/components/changelog';
import { Shell } from '@arki/sitekit/components/shell';
import { PageContainer } from '@arki/sitekit/layout/workspace/page-container.tsx';

import config from '~/config';
import { changelogs } from '~/content/util';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/changelog/')({
  validateSearch: (s: Record<string, unknown>) => ({ p: Number(s.p ?? 1) }),
  head: () =>
    getDefaultMeta({
      title: `Changelog | ${config.appTitle}`,
      description: `Latest updates and releases for ${config.appTitle}`,
    }),
  component: ChangelogPage,
});

function ChangelogPage() {
  const searchParams = Route.useSearch();

  return (
    <PageContainer>
      <Shell>
        <ChangelogTimeline
          posts={changelogs}
          Link={Link as Parameters<typeof ChangelogTimeline>[0]['Link']}
          searchParams={{ p: String(searchParams.p) }}
          appTitle={config.appTitle}
        />
      </Shell>
    </PageContainer>
  );
}
