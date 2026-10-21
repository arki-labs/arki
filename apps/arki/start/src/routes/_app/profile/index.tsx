import { createFileRoute, redirect } from '@tanstack/react-router';

import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/_app/profile/')({
  head: () => getDefaultMeta({ title: 'Profile' }),
  beforeLoad: async () => {
    // Imported on demand: `beforeLoad` stays in the main bundle, and a static import would ship the auth client to
    // every public page.
    const { authClient } = await import('~/features/auth/client');
    const session = await authClient.getSession();
    if (!session.data?.user) {
      throw redirect({ href: '/auth/sign-in' });
    }
    return { user: session.data.user };
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
