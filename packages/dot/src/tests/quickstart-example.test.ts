/**
 * The quickstart's example app boots, and the compile error the quickstart
 * quotes is still the one the guard prints.
 *
 * Why this test exists: `docs/quickstart.md` shows `docs/examples/quickstart.ts`
 * through `from=` blocks, which the doc checker does not compile. Importing the
 * file here puts it under `tsc` and vitest, so a broken example fails the
 * package, not a reader. The quoted type error is prose; this test pins it to
 * the guard in `define-app.ts`, so a renamed guard cannot leave the page stale.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import shop from '../../docs/examples/quickstart.js';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('quickstart example', () => {
  it('boots provider first, places an order through the needed db, and disposes', async () => {
    const app = await shop.boot();
    expect(app.manifest.plugins.map(entry => entry.name)).toEqual(['database', 'orders']);
    expect(app.services.orders.place(1250)).toEqual({ id: 1, cents: 1250 });
    expect(app.services.db.count()).toBe(1);
    await app.dispose();
  });

  it('quotes the guard message that the compiler prints for the wrong order', () => {
    const guard = /'(DOT: this unit needs services that nothing before it provides[^']*)'/.exec(
      read('../define-app.ts'),
    )?.[1];
    expect(guard).toBeDefined();
    expect(read('../../docs/quickstart.md')).toContain(`''${guard ?? ''}''`);
  });
});
