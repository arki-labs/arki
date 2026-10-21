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
 * still missing dist / docs (fs, emails, design-systems, icons)
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
        // schema and failure publish first: env needs schema, resilience needs failure.
        '@arki/schema',
        '@arki/failure',
        '@arki/contracts',
        '@arki/log',
        '@arki/ts',
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
      // @arki/cli publishes first: the dot CLI runs on it (A-32). `@arki/env`
      // and `@arki/resilience` moved here from Foundation 2026-10-21: both peer
      // on `@arki/dot`, and a wave may depend only on earlier waves.
      packages: ['@arki/cli', '@arki/dot', '@arki/env', '@arki/resilience'],
    },
    {
      id: 'frontend',
      label: 'Wave 3 — Frontend',
      // Promoted 2026-10-09 for the Drop Studio demo (external consumer of
      // the storefront stack). Leaves first: icons / design-systems
      // have no @arki deps; `@arki/ui` depends on both plus
      // `@arki/date` (Wave 1). `@arki/react-hooks` merged into
      // `@arki/ui/hooks/*` and `@arki/theme` into `@arki/ui/theme` on
      // 2026-10-21. Ships before infrastructure-adapters
      // since 2026-10-21: `@arki/auth` peers on `@arki/ui` and `@arki/icons`,
      // and nothing here depends on that wave.
      packages: ['@arki/icons', '@arki/design-systems', '@arki/ui'],
      // Source-first: these ship TypeScript source as the runtime entry plus
      // d.ts; every consumer is a bundler (Vite / Next / Start / Bun). Their
      // READMEs say so. Compiled dist output is a later, separate decision.
      buildOutput: 'source',
    },
    {
      id: 'infrastructure-adapters',
      label: 'Wave 4 — Infrastructure Adapters',
      // Stable v1: the env + kv + db trio — they pass every
      // scorecard dimension and back the DOT fixture. `@arki/http` joined
      // 2026-07-07 (typed HTTP + the DOT http() pip). `@arki/fs`,
      // `@arki/queue`, `@arki/auth`, `@arki/mail` rejoin this wave when
      // they ship dist+docs / drop `private: true`. `@arki/journal` joined
      // 2026-10-13 (Drizzle entity journal; depends on `@arki/log`, optional
      // `@arki/dot` peer). `@arki/live` joined 2026-10-17 (A-31: live queries;
      // peers `@arki/db`, `@arki/http`, `@arki/dot`). `@arki/lock`,
      // `@arki/mail` and `@arki/auth` joined 2026-10-20 (founder decision).
      // `@arki/schedule`, `@arki/queue` and `@arki/testing` joined 2026-10-21
      // (A-40, B8): schedule before queue (queue depends on it); testing last
      // (it peers on auth and needs db + kv).
      packages: [
        '@arki/db', '@arki/kv', '@arki/http', '@arki/journal', '@arki/live',
        '@arki/lock', '@arki/mail', '@arki/auth', '@arki/schedule', '@arki/queue',
        '@arki/testing',
      ],
    },
    {
      id: 'specialized',
      label: 'Wave 5 — Specialized',
      // `@arki/money` joined 2026-10-13 (exact money on `@arki/math`, so not
      // Foundation). `@arki/bench` joined 2026-10-13
      // (benchmark toolkit on mitata; no @arki deps, dev-time tool).
      // `@arki/payments` joined 2026-10-13 (Stripe provider, plans, subscriptions,
      // refunds, dunning and tax on `@arki/journal` + `@arki/money`; user ids
      // come from `@arki/contracts`).
      // `@arki/expr` and `@arki/cas` joined 2026-10-15 (formula parsing and
      // evaluation on `@arki/math`, and the bounded CAS on top of expr).
      packages: ['@arki/money', '@arki/bench', '@arki/payments', '@arki/expr', '@arki/cas'],
    },
    {
      id: 'ai',
      label: 'Wave 6 — AI',
      // Joined 2026-10-21 (A-40, B8): `@arki/ai` is admitted as it is today,
      // before the AI split. embeddings first (a hard dependency of ai);
      // chat-ui last (it imports ai's types and builds on the Frontend wave).
      packages: ['@arki/embeddings', '@arki/ai', '@arki/chat-ui'],
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
      '@arki/failure', '@arki/lock', '@arki/queue', '@arki/schedule', '@arki/testing',
      '@arki/ai', '@arki/chat-ui', '@arki/live', '@arki/embeddings',
    ],
    libraries: [
      '@arki/math', '@arki/money', '@arki/date', '@arki/string', '@arki/clock', '@arki/resilience',
      '@arki/ts', '@arki/bench', '@arki/icons', '@arki/async',
      '@arki/schema', '@arki/expr', '@arki/cas',
    ],
  },
  // Nested demo repos. `loadDemos` reads each one's arki.deps.json; a missing
  // folder (CI clones) is a warning, not a crash.
  demos: [
    { name: 'drop-studio', repo: 'arki-labs/drop-studio', path: 'demos/drop-studio' },
    { name: 'faultline', repo: 'arki-labs/faultline', path: 'demos/faultline' },
  ],
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
    {
      name: '@arki/admin',
      reason: 'public so @arki/journal can peer on it; first publish is Foreman F5-02 (0.1.0)',
    },
  ],
};

export default config;
