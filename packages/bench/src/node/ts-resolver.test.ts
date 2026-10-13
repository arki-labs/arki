import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const registerTypeScriptResolver = vi.hoisted(() => vi.fn());
vi.mock('./ts-resolver.js', () => ({ registerTypeScriptResolver }));

const { loadSuite } = await import('./run.js');

describe('loadSuite', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arki-bench-load-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('registers the .js → .ts resolver before importing, so check and list load suites like the worker does', async () => {
    // Without it, `arki-bench check` under Node fails on a suite that imports './helper.js' (helper.ts).
    const file = path.join(dir, 'x.bench.mjs');
    writeFileSync(
      file,
      "export default { id: 'x', groups: [{ kind: 'metric', id: 'm', title: 'M', unit: 'u', deterministic: true, baseline: 'a', cases: { a: { collect: () => 1 } } }] };\n",
    );
    await loadSuite(file);
    expect(registerTypeScriptResolver).toHaveBeenCalled();
  });
});
