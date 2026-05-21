import { createFileRoute } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/backoffice/_backoffice/')({
  head: () => getDefaultMeta({ title: 'Backoffice' }),
  component: BackofficeDashboard,
});

function BackofficeDashboard() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="mt-2 text-muted-foreground">Manage your application from here.</p>
    </div>
  );
}
