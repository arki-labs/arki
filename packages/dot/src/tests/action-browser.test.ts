import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('bundles the action contract for a browser without the executor or server capabilities', () => {
  const built = spawnSync(
    'bun',
    ['build', fileURLToPath(new URL('../action.ts', import.meta.url)), '--target=browser', '--minify'],
    { encoding: 'utf8' },
  );
  expect(built.status, built.stderr).toBe(0);
  expect(built.stdout).toContain('dot.action_principal_required');
  expect(built.stdout).not.toMatch(
    /node:|@orpc\/server|@opentelemetry|AsyncLocalStorage|createAppRuntime|withSpanContext|bindAction/,
  );
});
