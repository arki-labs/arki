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
 * placeholders for the eventual public `arki-dev/arki` repo. They live in
 * source control so the release tooling produces deterministic output and
 * the founder can swap them in one edit when the public repo is created.
 * Do NOT replace these with personal-account URLs — that is exactly the
 * leak surface the release rails exist to prevent.
 */
import type { ReleaseConfig } from './tooling/arki-release/src/types';

export const config: ReleaseConfig = {
  publicTreePath: '.release/arki-public',
  publicMetadataDefaults: {
    license: 'MIT',
    repository: {
      type: 'git',
      url: 'https://github.com/arki-dev/arki.git',
    },
    bugs: {
      url: 'https://github.com/arki-dev/arki/issues',
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
        '@arki/logger',
        '@arki/env',
        '@arki/ts',
        '@arki/resilience',
        '@arki/date',
        '@arki/string',
        '@arki/slugify',
        '@arki/clock',
      ],
    },
    {
      id: 'dot-kernel',
      label: 'Wave 2 — DOT Kernel',
      packages: ['@arki/dot'],
    },
    {
      id: 'infrastructure-adapters',
      label: 'Wave 3 — Infrastructure Adapters',
      packages: [
        '@arki/db',
        '@arki/kv',
        '@arki/fs',
        '@arki/queue',
        '@arki/event-sourcing',
        '@arki/auth',
        '@arki/emails',
      ],
    },
    {
      id: 'frontend',
      label: 'Wave 4 — Frontend',
      packages: [
        '@arki/design-systems',
        '@arki/theme',
        '@arki/icons',
        '@arki/react-hooks',
        '@arki/ui',
      ],
    },
    {
      id: 'specialized',
      label: 'Wave 5 — Specialized',
      packages: [
        '@arki/ai',
        '@arki/rich-text',
        '@arki/images',
        '@arki/diff-engine',
      ],
    },
  ],
};

export default config;
