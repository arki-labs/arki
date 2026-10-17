/**
 * `@arki/testing/services/redis` — one Redis container per worker. A built production server
 * demands a KV store at boot, so every worker gets its own.
 */
import { GenericContainer, Wait } from 'testcontainers';

import { service } from '../stack/index.js';
import { nothingToStop, once, RUN_LABEL } from './labels.js';

export type RedisWorker = { readonly url: string };

export const redis = (options: { readonly image?: string } = {}) =>
  service<null, RedisWorker>({
    name: 'redis',
    scope: 'worker',
    async start() {
      return { value: null, stop: nothingToStop };
    },
    async slice(_run, ctx) {
      const container = await new GenericContainer(options.image ?? 'redis:7-alpine')
        .withExposedPorts(6379)
        .withLabels({ [RUN_LABEL]: ctx.runId })
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start();
      return {
        value: { url: `redis://${container.getHost()}:${container.getMappedPort(6379)}` },
        stop: once(() => container.stop()),
      };
    },
  });
