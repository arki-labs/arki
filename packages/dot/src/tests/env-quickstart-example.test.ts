/**
 * The env quickstart example boots and publishes a typed `env` service.
 *
 * Why this test exists: importing `docs/examples/env-quickstart.ts` puts it under `tsc` and vitest,
 * so a broken example fails the package, not a reader.
 */
import { orThrow } from '@arki/failure';
import { describe, expect, it } from 'vitest';

import app from '../../docs/examples/env-quickstart.js';

describe('env quickstart example', () => {
  it('boots with schema defaults and types PORT as a number', async () => {
    const booted = orThrow(await app.boot());
    expect(typeof booted.services.env.PORT).toBe('number');
    orThrow(await booted.dispose());
  });
});
