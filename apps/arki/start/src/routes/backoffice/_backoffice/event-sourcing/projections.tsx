import { createFileRoute } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/backoffice/_backoffice/event-sourcing/projections')({
  head: () => getDefaultMeta({ title: 'Projections' }),
  component: ProjectionsPage,
});

function ProjectionsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Projections</h1>
      <p className="mt-2 text-muted-foreground">View and manage your read model projections.</p>
    </div>
  );
}
