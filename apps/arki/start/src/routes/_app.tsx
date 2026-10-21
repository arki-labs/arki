import { createFileRoute, Link, Outlet } from '@tanstack/react-router';

import { WorkspaceLayout } from '@fleet/sitekit/layout/workspace/layout.tsx';

import { ensureSession } from '~/features/auth/prefetch-session';
import { SignedInProviders } from '~/providers';

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context }) => ensureSession(context.queryClient),
  component: AppLayout,
  notFoundComponent: AppNotFoundContent,
});

function AppLayout() {
  return (
    <SignedInProviders>
      <WorkspaceLayout>
        <Outlet />
      </WorkspaceLayout>
    </SignedInProviders>
  );
}

function AppNotFoundContent() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">Page not found</p>
      <Link to="/" className="text-primary hover:underline">
        Go home
      </Link>
    </div>
  );
}
