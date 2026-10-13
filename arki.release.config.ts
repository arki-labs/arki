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
        '@arki/contracts',
        '@arki/log',
        '@arki/env',
        '@arki/ts',
        '@arki/resilience',
        '@arki/date',
        '@arki/string',
        '@arki/clock',
        '@arki/math',
      ],
    },
    {
      id: 'dot-kernel',
      label: 'Wave 2 — DOT Kernel',
      // @arki/feature is the authoring layer over the kernel: zero runtime
      // deps, optional @arki/dot peer — it ships with the kernel wave.
      packages: ['@arki/dot', '@arki/feature'],
    },
    {
      id: 'infrastructure-adapters',
      label: 'Wave 3 — Infrastructure Adapters',
      // Stable v1: the env + kv + db trio — they pass every
      // scorecard dimension and back the DOT fixture. `@arki/http` joined
      // 2026-07-07 (typed HTTP + the DOT http() pip). `@arki/fs`,
      // `@arki/queue`, `@arki/auth`, `@arki/emails` rejoin this wave when
      // they ship dist+docs / drop `private: true`. `@arki/journal` joined
      // 2026-10-13 (Drizzle entity journal; depends on `@arki/log`, optional
      // `@arki/dot` peer).
      packages: ['@arki/db', '@arki/kv', '@arki/http', '@arki/journal'],
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
      // `@arki/images`, `@arki/diff-engine`) are still `private: true`; they
      // join once their internals stabilise. `@arki/bench` joined 2026-10-13
      // (benchmark toolkit on mitata; no @arki deps, dev-time tool).
      // `@arki/payments` joined 2026-10-13 (Stripe provider, plans, subscriptions,
      // refunds, dunning and tax on `@arki/journal` + `@arki/money`; user ids
      // come from `@arki/contracts`).
      packages: ['@arki/money', '@arki/bench', '@arki/payments'],
    },
  ],
};

export default config;
