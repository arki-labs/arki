/**
 * Error codes that existed in a released version and are gone from the current one. `/errors/<code>` shows a
 * "removed" page for each, so a link in an old issue or an old changelog does not end in a 404. `removed-codes.test.ts`
 * checks that every code points at a live replacement.
 */
export const removedCodes = [
  {
    code: 'DOT_CLI_E001',
    package: '@arki/dot',
    short: 'dot',
    lastVersion: '0.6.1',
    removedIn: '0.7.0',
    meant: 'No app file could be discovered at the cwd and `--app` was not provided.',
    // It was `AppNotFound` in packages/dot/src/cli/error-codes.ts:11 before commit afecc7a3e5.
    source: 'src/cli/error-codes.ts:11',
    replacedBy: 'dot.app_not_found',
    upgradeDoc: 'docs/upgrades/0.6.1-to-0.7.0',
  },
] as const;

export function findRemovedCode(code: string) {
  return removedCodes.find(entry => entry.code === code) ?? null;
}
