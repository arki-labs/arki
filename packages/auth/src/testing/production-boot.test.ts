import { describe, expect, it } from 'vitest';

import { assertEmailPasswordEnabled } from './production-boot';

// @story workspace/cross-app-auth-prod-fix/US-01
describe('production-boot helper (C1 regression self-test)', () => {
  it('passes for a defineAuthBackend config WITH explicit emailAndPassword', async () => {
    await expect(
      assertEmailPasswordEnabled(async () => {
        const { authWithExplicit } = await import('./__fixtures__/auth-fixtures');
        return { auth: authWithExplicit };
      }),
    ).resolves.toBeDefined();
  });

  it('fails for a defineAuthBackend config WITHOUT explicit emailAndPassword', async () => {
    await expect(
      assertEmailPasswordEnabled(async () => {
        const { authWithoutExplicit } = await import('./__fixtures__/auth-fixtures');
        return { auth: authWithoutExplicit };
      }),
    ).rejects.toThrow();
  });
});
