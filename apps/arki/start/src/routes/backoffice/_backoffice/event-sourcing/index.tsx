import { createFileRoute } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/backoffice/_backoffice/event-sourcing/')({
  head: () => getDefaultMeta({ title: 'Event Sourcing Dashboard' }),
  component: EventSourcingDashboard,
});

function EventSourcingDashboard() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Event Sourcing</h1>
      <p className="mt-2 text-muted-foreground">Monitor and analyze your event streams.</p>
    </div>
  );
}
