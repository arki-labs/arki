/**
 * ARKI public release configuration.
 *
 * Source of truth for:
 *   - The generated public-tree path (`.release/arki-public`).
 *   - Public manifest metadata defaults (MIT license, repository, bugs,
 *     homepage, publishConfig, keywords).
 *   - The ordered list of release waves and the `@arki/*` packages each
 *     wave promises to publish together.
 *
 * Loaded by `tooling/arki-release/src/config.ts`. Every subcommand of
 * `bun release:arki` validates the config shape before running.
 *
 * Note on URLs: the repository / bugs / homepage values are intentional
 * placeholders for the eventual public `arki-labs/arki` repo. They live in
 * source control so the release tooling produces deterministic output and
 * the founder can swap them in one edit when the public repo is created.
 * Do NOT replace these with personal-account URLs — that is exactly the
 * leak surface the release rails exist to prevent.
 *
 * Wave discipline (per the public-release plan, doctrine section):
 *
 *   > First stable release should be smaller and excellent rather than
 *   > broad and uneven.
 *
 * Only packages that pass every scorecard dimension belong in an active
 * wave. Packages that are still `private: true` (auth, queue, ai, …) or
 * still missing dist / docs (fs, emails, design-systems, theme, icons)
 * stay out of the waves until they earn their seat. Each excluded
 * package keeps its `private: true` flag (or, for unfinished public
 * candidates, its un-allowlisted state) — the inventory command surfaces
 * the gap so it can be closed in a later wave.
 */
import type { ReleaseConfig } from './tooling/arki-release/src/types';

export const config: ReleaseConfig = {
  publicTreePath: '.release/arki-public',
  publicMetadataDefaults: {
    license: 'MIT',
    repository: {
      type: 'git',
      url: 'https://github.com/arki-labs/arki.git',
    },
    bugs: {
      url: 'https://github.com/arki-labs/arki/issues',
    },
    homepage: 'https://arki.dev',
    publishConfig: {
      access: 'public',
    },
    keywords: ['arki', 'typescript'],
  },
  waves: [
    {
      id: 'foundation',
      label: 'Wave 1 — Foundation',
      packages: [
        '@arki/assert',
        // schema and failure publish first: env needs schema, resilience needs failure.
        '@arki/schema',
        '@arki/failure',
        '@arki/contracts',
        '@arki/log',
        '@arki/env',
        '@arki/ts',
        '@arki/resilience',
        '@arki/date',
        '@arki/string',
        '@arki/clock',
        '@arki/math',
        '@arki/async',
      ],
    },
    {
      id: 'dot-kernel',
      label: 'Wave 2 — DOT Kernel',
      // @arki/cli publishes first: the dot CLI runs on it (A-32).
      packages: ['@arki/cli', '@arki/dot'],
    },
    {
      id: 'infrastructure-adapters',
      label: 'Wave 3 — Infrastructure Adapters',
      // Stable v1: the env + kv + db trio — they pass every
      // scorecard dimension and back the DOT fixture. `@arki/http` joined
      // 2026-07-07 (typed HTTP + the DOT http() pip). `@arki/fs`,
      // `@arki/queue`, `@arki/auth`, `@arki/mail` rejoin this wave when
      // they ship dist+docs / drop `private: true`. `@arki/journal` joined
      // 2026-10-13 (Drizzle entity journal; depends on `@arki/log`, optional
      // `@arki/dot` peer). `@arki/live` joined 2026-10-17 (A-31: live queries;
      // peers `@arki/db`, `@arki/http`, `@arki/dot`).
      packages: ['@arki/db', '@arki/kv', '@arki/http', '@arki/journal', '@arki/live'],
    },
    {
      id: 'frontend',
      label: 'Wave 4 — Frontend',
      // Promoted 2026-10-09 for the Drop Studio demo (external consumer of
      // the storefront stack). Leaves first: theme / icons / react-hooks /
      // design-systems have no @arki deps; `@arki/ui` depends on all four
      // plus `@arki/date` (Wave 1).
      packages: ['@arki/theme', '@arki/icons', '@arki/react-hooks', '@arki/design-systems', '@arki/ui'],
      // Source-first: these ship TypeScript source as the runtime entry plus
      // d.ts; every consumer is a bundler (Vite / Next / Start / Bun). Their
      // READMEs say so. Compiled dist output is a later, separate decision.
      buildOutput: 'source',
    },
    {
      id: 'specialized',
      label: 'Wave 5 — Specialized',
      // `@arki/money` joined 2026-10-13 (exact money on `@arki/math`, so not
      // Foundation). Other candidates (`@arki/ai`, `@arki/rich-text`,
      // `@arki/images`, `@arki/diff`) are still `private: true`; they
      // join once their internals stabilise. `@arki/bench` joined 2026-10-13
      // (benchmark toolkit on mitata; no @arki deps, dev-time tool).
      // `@arki/payments` joined 2026-10-13 (Stripe provider, plans, subscriptions,
      // refunds, dunning and tax on `@arki/journal` + `@arki/money`; user ids
      // come from `@arki/contracts`).
      // `@arki/expr` and `@arki/cas` joined 2026-10-15 (formula parsing and
      // evaluation on `@arki/math`, and the bounded CAS on top of expr).
      packages: ['@arki/money', '@arki/bench', '@arki/payments', '@arki/expr', '@arki/cas'],
    },
  ],
  // Package tiers, mirroring docs/arki/core-packages.md. Tier 1 is the stack,
  // Tier 2 the standalone libraries; they decide which readiness items bind a
  // package, and a Tier 2 package with no @arki deps is a leaf library
  // (runtimes + bench-fresh). `@arki/live` joined the stack 2026-10-17 (A-31).
  tiers: {
    stack: [
      '@arki/dot', '@arki/cli', '@arki/env', '@arki/http', '@arki/contracts', '@arki/db', '@arki/journal', '@arki/kv',
      '@arki/log', '@arki/mail', '@arki/auth', '@arki/payments', '@arki/ui', '@arki/design-systems',
      '@arki/theme', '@arki/failure', '@arki/lock', '@arki/queue', '@arki/schedule', '@arki/testing',
      '@arki/ai', '@arki/chat-ui', '@arki/live',
    ],
    libraries: [
      '@arki/math', '@arki/money', '@arki/date', '@arki/string', '@arki/clock', '@arki/resilience',
      '@arki/assert', '@arki/ts', '@arki/bench', '@arki/react-hooks', '@arki/icons', '@arki/async',
      '@arki/schema', '@arki/expr', '@arki/cas',
    ],
  },
  // Nested demo repos. `loadDemos` reads each one's arki.deps.json; a missing
  // folder (CI clones) is a warning, not a crash.
  demos: [{ name: 'drop-studio', repo: 'arki-labs/drop-studio', path: 'demos/drop-studio' }],
  // Behavioural mappings on top of real imports: { '@arki/x': [{ demo, scenario }] }.
  proofs: {
    // The CLI is not imported by any demo, so name the scenario that runs it.
    '@arki/cli': [{ demo: 'drop-studio', scenario: 'dot doctor --app backend/src/app.ts --json exits 0' }],
  },
  // Demo lag is warning-only until two waves have shipped with the dimension.
  demoLagBlocking: false,
  // Public packages deliberately outside every wave. The `admission`
  // scorecard dimension fails a public package that is in no wave and not
  // listed here (ADMIT_E001), or in both (ADMIT_E002).
  notYet: [
    { name: '@arki/auth', reason: 'awaiting security tests W2-02' },
    { name: '@arki/lock', reason: 'admitted (A-28); joins a wave after its docs batch passes' },
    { name: '@arki/mail', reason: 'Tier 1; joins a wave after its docs batch (B3) passes' },
  ],
};

export default config;
