/**
 * A lazy command tree for the help and resolution tests. Each lazy module
 * bumps a counter when it is imported, so a test can prove which ones help
 * and `--version` loaded. `admin/broken` throws on import and sits two
 * levels down: root help imports `admin` (one level) but never `broken`.
 */
import { defineCli } from '../cli.js';
import { group } from '../tree.js';

export const imports = new Map<string, number>();

export function imported(name: string): void {
  imports.set(name, (imports.get(name) ?? 0) + 1);
}

export function fixtureCli(services?: () => unknown) {
  return defineCli({
    name: 'fixture',
    version: '1.2.3',
    describe: 'A lazy fixture',
    docsUrl: 'https://example.test/cli',
    ...(services === undefined ? {} : { services }),
    commands: {
      bench: () => import('./groups/bench.js'),
      seed: () => import('./groups/seed.js'),
      admin: () => import('./groups/admin.js'),
      ping: group('Health checks', { now: () => import('./groups/ping-now.js') }),
    },
  });
}
