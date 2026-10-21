import { createFileRoute, redirect } from '@tanstack/react-router';

import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import { prefetchSessionFn } from '~/features/auth/prefetch-session';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/_app/profile/')({
  head: () => getDefaultMeta({ title: 'Profile' }),
  beforeLoad: async () => {
    // A server function, not the browser auth client: during server rendering the auth client cannot reach the auth
    // API with the visitor's cookies, so a signed-out first load became a 500 instead of this redirect.
    const principal = await prefetchSessionFn();
    if (!principal) {
      throw redirect({ href: '/auth/sign-in' });
    }
    return { user: principal.user };
  },
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = Route.useRouteContext();

  return (
    <PageContainer>
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-muted-foreground">{user.email}</p>
      </div>
    </PageContainer>
  );
}
