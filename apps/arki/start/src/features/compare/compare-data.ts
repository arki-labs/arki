/**
 * The compare table, as one typed module. It replaces the plan's `src/content/pages/compare.md`: every arki cell
 * names a package, and `compare-data.test.ts` checks each one against the generated package list. A markdown
 * table cannot be checked that way, so a renamed or dropped package would leave a dead link.
 *
 * Claims about other frameworks are kept short and well known. A founder should still review them
 * (see the T3.7 report).
 */

/** The three frameworks arki is compared with, in column order. */
export const OTHER_FRAMEWORKS = [
  { id: 'laravel', name: 'Laravel' },
  { id: 'rails', name: 'Rails' },
  { id: 'adonis', name: 'AdonisJS' },
] as const;

export const compareRows = [
  {
    feature: 'Dependency injection and app structure',
    laravel: 'Service container and service providers.',
    rails: 'No container. Conventions and autoloading.',
    adonis: 'IoC container and providers.',
    arki: { state: 'shipped', short: 'dot' },
  },
  {
    feature: 'Command line and generators',
    laravel: 'Artisan.',
    rails: 'The rails command and generators.',
    adonis: 'Ace.',
    arki: { state: 'shipped', short: 'cli' },
  },
  {
    feature: 'Validation',
    laravel: 'Validator and form requests.',
    rails: 'Active Model validations.',
    adonis: 'VineJS.',
    arki: { state: 'shipped', short: 'schema' },
  },
  {
    feature: 'Database access',
    laravel: 'Eloquent.',
    rails: 'Active Record.',
    adonis: 'Lucid.',
    arki: { state: 'shipped', short: 'db' },
  },
  {
    feature: 'Payments',
    laravel: 'Cashier.',
    rails: 'Community gems.',
    adonis: 'No first-party package.',
    arki: { state: 'shipped', short: 'payments' },
  },
  {
    feature: 'UI components',
    laravel: 'Blade and starter kits.',
    rails: 'ERB views and Hotwire.',
    adonis: 'Edge templates and an Inertia adapter.',
    arki: { state: 'shipped', short: 'ui' },
  },
  {
    feature: 'Login and sessions',
    laravel: 'Starter kits, Fortify and Sanctum.',
    rails: 'Built-in authentication generator.',
    adonis: 'First-party auth package.',
    arki: { state: 'planned', wave: 'infrastructure-adapters' },
  },
  {
    feature: 'Email',
    laravel: 'Mail.',
    rails: 'Action Mailer.',
    adonis: 'First-party mail package.',
    arki: { state: 'planned', wave: 'infrastructure-adapters' },
  },
  {
    feature: 'Live updates',
    laravel: 'Reverb and Echo.',
    rails: 'Action Cable.',
    adonis: 'Transmit.',
    arki: { state: 'planned', wave: 'infrastructure-adapters' },
  },
  {
    feature: 'Background jobs',
    laravel: 'Queues.',
    rails: 'Active Job.',
    adonis: 'Community packages.',
    arki: { state: 'planned', wave: 'admission batch B8' },
  },
  {
    feature: 'Scheduled tasks',
    laravel: 'Task scheduling.',
    rails: 'Recurring tasks in Solid Queue.',
    adonis: 'Community packages.',
    arki: { state: 'planned', wave: 'admission batch B8' },
  },
  {
    feature: 'Test helpers',
    laravel: 'PHPUnit and Pest support.',
    rails: 'Minitest, built in.',
    adonis: 'Japa test runner.',
    arki: { state: 'planned', wave: 'admission batch B8' },
  },
  {
    feature: 'Own router',
    laravel: 'Built in.',
    rails: 'Built in.',
    adonis: 'Built in.',
    arki: { state: 'not-planned', reason: 'Arki uses TanStack Start for routing. The strategy rules out a new router.' },
  },
  {
    feature: 'Admin panel generator',
    laravel: 'Nova, a paid first-party product.',
    rails: 'Community gems.',
    adonis: 'Community packages.',
    arki: { state: 'not-planned', reason: 'The strategy rules out a Nova-style admin generator.' },
  },
  {
    feature: 'Hosting product',
    laravel: 'Forge and Cloud.',
    rails: 'Kamal for deploys.',
    adonis: 'No first-party hosting product.',
    arki: { state: 'not-planned', reason: 'The strategy rules out a hosting or deploy product. Arki publishes a Coolify recipe instead.' },
  },
] as const;

export type CompareRow = (typeof compareRows)[number];
export type ArkiCell = CompareRow['arki'];

export const chooseSomethingElse = [
  'You write PHP or Ruby. Arki is TypeScript only.',
  'You want one framework to own the router, the database layer and the views. Arki picks TanStack Start and Drizzle for those.',
  'You need a 1.0 API today. Arki packages are 0.x, and breaking changes ship in minor versions.',
  'You want your hosting from the framework vendor. Arki does not sell hosting.',
] as const;

export const adoptingDotCosts = [
  'You learn how Dot builds an app: defineApp, plugins and services that are built from their dependencies.',
  'Dot is 0.x. Breaking changes are listed in its upgrade guide, version by version.',
  'The files `dot new` writes are yours. Later upgrades come as steps you review, not silent edits.',
] as const;
