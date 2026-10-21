/** The header's main links, in order. */
export const MAIN_LINKS = [
  { to: '/docs', label: 'Docs' },
  { to: '/packages', label: 'Packages' },
  { to: '/inside', label: "What's inside" },
  { to: '/agents', label: 'Agents' },
] as const;

/** A doc of a package snapshot (`/packages/dot/next/docs/recipes/deploy`); `/packages/dot/next` is the package page. */
const packageDocPath = /^\/packages\/[^/]+\/[^/]+\/docs\//;

/** The main link whose section holds `pathname`. Package docs belong to Docs, though their URL starts with `/packages`. */
export function activeMainLink(pathname: string): (typeof MAIN_LINKS)[number]['to'] | null {
  if (packageDocPath.test(pathname)) return '/docs';
  return MAIN_LINKS.find(link => pathname === link.to || pathname.startsWith(`${link.to}/`))?.to ?? null;
}
