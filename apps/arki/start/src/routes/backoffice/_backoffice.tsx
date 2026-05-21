import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router';

import { cn } from '@arki/ui/cn';

const navigation = [
  { name: 'Dashboard', href: '/backoffice' },
  { name: 'Event Sourcing', href: '/backoffice/event-sourcing' },
];

export const Route = createFileRoute('/backoffice/_backoffice')({
  component: BackofficeLayout,
});

function BackofficeLayout() {
  const location = useLocation();

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 border-r bg-card md:flex md:flex-col">
        <div className="flex h-14 items-center border-b px-4 font-semibold">Backoffice</div>
        <nav className="flex-1 space-y-1 p-2">
          {navigation.map(item => {
            const isActive =
              location.pathname === item.href ||
              (item.href !== '/backoffice' && location.pathname.startsWith(item.href));
            return (
              <Link
                key={item.name}
                to={item.href}
                className={cn(
                  'flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {item.name}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
