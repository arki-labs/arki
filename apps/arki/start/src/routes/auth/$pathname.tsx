import { createFileRoute } from '@tanstack/react-router';
import { AuthView } from '@daveyplate/better-auth-ui';

import { PageContainer } from '@arki/sitekit/layout/workspace/page-container.tsx';
import { WorkspaceLayout } from '@arki/sitekit/layout/workspace/layout.tsx';

import { signInPill } from '~/shared/sign-in-pill';

export const Route = createFileRoute('/auth/$pathname')({
  component: AuthPage,
});

function AuthPage() {
  const { pathname } = Route.useParams();
  return (
    <WorkspaceLayout defaultSidebarOpen={false} slots={{ sidebar: { signInPill } }}>
      <PageContainer className="items-center justify-center">
        <div className="w-full max-w-sm">
          <AuthView pathname={pathname} />
        </div>
      </PageContainer>
    </WorkspaceLayout>
  );
}
