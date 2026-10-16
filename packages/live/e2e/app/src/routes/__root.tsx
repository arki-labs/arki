import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createRootRouteWithContext, HeadContent, Scripts } from '@tanstack/react-router';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({ meta: [{ charSet: 'utf8' }, { title: '@arki/live e2e' }] }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
