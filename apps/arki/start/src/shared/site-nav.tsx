import { Link, Outlet } from '@tanstack/react-router';

/** The reference sections every docs-like page links to. One list feeds the header on all of them. */
const SITE_SECTIONS = [
  { to: '/docs', label: 'Docs' },
  { to: '/packages', label: 'Packages' },
  { to: '/errors', label: 'Errors' },
  { to: '/compare', label: 'Compare' },
] as const;

/**
 * Plain site navigation for the docs, packages, errors, compare and agents pages. The links stay visible at every
 * width (they wrap on a phone), unlike the page breadcrumb, which hides its parent links below `md`. Plain markup on
 * purpose: the design track restyles it later.
 */
export function SiteNav() {
  return (
    <header className="max-w-[1800px] px-4 pt-4 md:px-6 lg:px-8">
      <nav aria-label="Site">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <li>
            <a href="/" className="font-semibold">
              arki
            </a>
          </li>
          {SITE_SECTIONS.map(section => (
            <li key={section.to}>
              <Link to={section.to} className="hover:underline" activeProps={{ className: 'font-semibold' }}>
                {section.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

/** Layout for a reference section route (`docs`, `packages`, `errors`, `compare`, `agents`): site nav, then the page. */
export function SiteSectionLayout() {
  return (
    <>
      <SiteNav />
      <Outlet />
    </>
  );
}
