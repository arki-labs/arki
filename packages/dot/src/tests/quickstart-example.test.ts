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
import { orThrow } from '@arki/failure';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import shop from '../../docs/examples/quickstart.js';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('quickstart example', () => {
  it('boots infra in order, then the feature, and both write through the one db', async () => {
    const app = orThrow(await shop.boot());
    expect(app.manifest.plugins.map(entry => [entry.name, entry.role])).toEqual([
      ['database', 'infra'],
      ['sessions', 'infra'],
      ['orders', 'feature'],
    ]);
    expect(app.services.sessions.open('u1')).toEqual({ userId: 'u1' });
    expect(app.services.orders.place(1250)).toEqual({ id: 1, cents: 1250 });
    // Both units got the same db instance: the graph wires one provider to every unit that needs it.
    expect([app.services.db.count('sessions'), app.services.db.count('orders')]).toEqual([1, 1]);
    orThrow(await app.dispose());
  });

  it('quotes the guard message that the compiler prints for the wrong order', () => {
    const source = read('../define-app.ts');
    const page = read('../../docs/quickstart.md');
    const guard = /'(DOT: a unit in this list cannot be mounted at its position)'/.exec(source)?.[1];
    expect(guard).toBeDefined();
    expect(page).toContain(`''${guard ?? ''}''`);
    // The page names the alias the compiler prints for the reason, so renaming it must update the page.
    expect(source).toContain('type NeedsError<');
    expect(page).toContain('NeedsError<EmptyShape');
  });
});
