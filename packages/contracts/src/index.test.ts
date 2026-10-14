import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Bundles one entry with drizzle-orm kept external and returns the bundle text. */
function bundleWithDrizzleExternal(entry: string): string {
  const entryPath = fileURLToPath(new URL(entry, import.meta.url));
  const script = `
    const result = await Bun.build({
      entrypoints: [${JSON.stringify(entryPath)}],
      external: ['drizzle-orm', 'drizzle-orm/*'],
      target: 'browser',
    });
    if (!result.success) throw new Error(result.logs.join('\\n'));
    const [output] = result.outputs;
    if (!output) throw new Error('no output');
    process.stdout.write(await output.text());
  `;
  const run = spawnSync('bun', ['-e', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`bundle failed: ${run.stderr}`);
  return run.stdout;
}

describe('@arki/contracts entries', () => {
  it('the portable entry never reaches drizzle-orm', () => {
    expect(bundleWithDrizzleExternal('./index.ts')).not.toMatch(/drizzle-orm/);
  });

  it('the /drizzle entry does import drizzle-orm (so the check above can fail)', () => {
    expect(bundleWithDrizzleExternal('./drizzle.ts')).toMatch(/drizzle-orm/);
  });
});
