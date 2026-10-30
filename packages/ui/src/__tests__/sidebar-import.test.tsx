/// <reference types="node" />

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Deno without `--allow-env` throws when code reads `process.env.DEBUG`. Importing the sidebar must
 * still work there: a UI component may not need env permission just to load.
 */
describe('sidebar import without env permission', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('loads when reading DEBUG throws', async () => {
    const guardedEnv = new Proxy(process.env, {
      get(target, key, receiver) {
        if (key === 'DEBUG') throw new Error('NotCapable: Requires env access to "DEBUG"');
        return Reflect.get(target, key, receiver);
      },
    });
    const guardedProcess = new Proxy(process, {
      get(target, key, receiver) {
        return key === 'env' ? guardedEnv : Reflect.get(target, key, receiver);
      },
    });
    vi.resetModules();
    vi.stubGlobal('process', guardedProcess);
    const sidebar = await import('../sidebar');
    // forwardRef returns an object, so the check is that the export arrived, not its kind.
    expect(sidebar.SidebarProvider).toBeDefined();
  });
});
