import { fakeLog } from '@arki/log/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('virtual:pwa-register', () => {
  throw new Error('chunk blocked');
});

describe('registerPwa', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs a warning instead of an unhandled rejection when virtual:pwa-register fails to load', async () => {
    using fake = fakeLog();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    vi.stubGlobal('window', { addEventListener: vi.fn(), location: { reload: vi.fn() } });
    vi.stubGlobal('navigator', { serviceWorker: {} });

    const { registerPwa } = await import('./client.js');
    expect(() => registerPwa()).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 20));
    process.off('unhandledRejection', onUnhandled);

    expect(unhandled).toEqual([]);
    fake.assertLogged({ level: 'warn' });
  });
});
