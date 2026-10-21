import { createFileRoute } from '@tanstack/react-router';
import { AuthView } from '@daveyplate/better-auth-ui';

import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';
import { WorkspaceLayout } from '@fleet/sitekit/layout/workspace/layout.tsx';

import { ensureSession } from '~/features/auth/prefetch-session';
import { SignedInProviders } from '~/providers';
import { signInPill } from '~/shared/sign-in-pill';

export const Route = createFileRoute('/auth/$pathname')({
  beforeLoad: ({ context }) => ensureSession(context.queryClient),
  component: AuthPage,
});

function AuthPage() {
  const { pathname } = Route.useParams();
  return (
    <SignedInProviders>
      <WorkspaceLayout defaultSidebarOpen={false} slots={{ sidebar: { signInPill } }}>
        <PageContainer className="items-center justify-center">
          <div className="w-full max-w-sm">
            <AuthView pathname={pathname} />
          </div>
        </PageContainer>
      </WorkspaceLayout>
    </SignedInProviders>
  );
}
