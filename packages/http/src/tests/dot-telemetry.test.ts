/**
 * Inside a Dot app, the spans of `@arki/http` and Dot's own spans form one
 * trace: the request span holds the usecase span, and a webhook the usecase
 * signs nests under the usecase. So a trace shows which request ran which
 * usecase, and which usecase did the HTTP work.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFeature } from '@arki/dot/feature';
import { defineApp } from '@arki/dot/unit';
import { isFailure, orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

import { routes } from '../bundle.js';
import { route } from '../contract.js';
import { endpoints, http } from '../dot.js';
import { standardWebhooks } from '../webhooks.js';

const notify = route.get('/notify', { id: 'hooks.notify', output: z.object({ signed: z.boolean() }) });
const scheme = standardWebhooks({ secrets: ['cHJpdmF0ZS1zZWNyZXQ='] });
const signOrder = () => scheme.sign('{"order":"o1"}');

const hooksCore = defineFeature('hooks').usecases({ sign: () => signOrder });
const hooks = hooksCore.entrypoints(
  endpoints(
    hooksCore,
    ({ usecases }) =>
      routes().bind(notify, async () => {
        const headers = await usecases.sign();
        return { signed: !isFailure(headers) };
      }),
    { contracts: [notify] },
  ),
);

describe('@arki/http spans inside a Dot app', () => {
  it('nests the webhook span under the Dot usecase, and the usecase under the request, so a trace shows which unit did the work', async () => {
    using spans = captureSpans();
    const app = orThrow(
      await defineApp('http-telemetry')
        .features([hooks])
        .entrypoints(http({ port: 0 }))
        .boot(),
    );
    try {
      const response = await app.services.httpServer.fetch(new Request('http://in-process/notify'));
      expect(await response.json()).toEqual({ signed: true });
    } finally {
      orThrow(await app.dispose());
    }

    const usecase = spans.named('feature.hooks.sign');
    expect(spans.named('http.webhook.sign').parent).toBe(usecase);
    expect(usecase.parent).toBe(spans.named('http.request'));
  });
});
