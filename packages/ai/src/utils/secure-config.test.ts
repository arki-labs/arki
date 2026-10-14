import { afterEach, expect, test, vi } from 'vitest';

import { SecureConfig } from './secure-config';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('refuses to start without an encryption key, so no shared default key can protect secrets', () => {
  vi.stubEnv('ENCRYPTION_KEY', '');
  expect(() => new SecureConfig()).toThrow(/encryption key/i);
});

test('uses the explicit key option and round-trips a value', () => {
  vi.stubEnv('ENCRYPTION_KEY', '');
  const config = new SecureConfig({ encryptionKey: 'k'.repeat(32), validateOnAccess: false });
  config.set('api', 'secret-value');
  expect(config.get('api')).toBe('secret-value');
});

test('reads the key from ENCRYPTION_KEY when no option is given', () => {
  vi.stubEnv('ENCRYPTION_KEY', 'env-key-for-tests');
  const config = new SecureConfig({ validateOnAccess: false });
  config.set('api', 'secret-value');
  expect(config.get('api')).toBe('secret-value');
});
