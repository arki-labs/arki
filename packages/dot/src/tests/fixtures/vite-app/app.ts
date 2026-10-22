/** A Dot app the way `@arki/dot/vite` imports it: inert on import, one plugin, one registered projection. */
import { defineApp } from '../../../define-app.js';
import { plugin } from '../../../plugin-contract.js';

export const app = defineApp('vite-fixture').infra(
  plugin({
    name: 'greeter',
    configure(ctx) {
      ctx.registerProjection({ format: 'routes', binding: 'greeter', module: './projection.ts' });
    },
    provides: {
      greeting: () => 'hello',
    },
  }),
);
