import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { aiTelemetry } from './telemetry';

const exporter = new InMemorySpanExporter();

function model(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'pong' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

describe('aiTelemetry', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  });

  afterEach(() => {
    exporter.reset();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    trace.disable();
  });

  it('is a no-op when no OTel backend is configured', async () => {
    // WHY: apps without an OTLP endpoint must not pay for, or leak into, tracing.
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');

    expect(aiTelemetry('test.generateText')).toEqual({});
    await generateText({ model: model(), prompt: 'ping', ...aiTelemetry('test.generateText') });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('records the prompt, completion and function id on gen_ai spans when a backend is configured', async () => {
    // WHY: AI SDK 7 stopped emitting spans from `ai` itself. Without the
    // `@ai-sdk/otel` integration this helper passes, traces silently go empty
    // and a mid-chain generation failure is invisible again.
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');

    await generateText({ model: model(), prompt: 'ping', ...aiTelemetry('test.generateText') });

    const root = exporter.getFinishedSpans().find(span => span.attributes['gen_ai.agent.name'] === 'test.generateText');
    expect(root).toBeDefined();
    expect(root?.attributes['gen_ai.input.messages']).toContain('ping');
    expect(root?.attributes['gen_ai.output.messages']).toContain('pong');
    expect(root?.attributes['gen_ai.usage.input_tokens']).toBe(3);
  });

  it('does not trace calls that do not spread the helper, even after it has been used', async () => {
    // WHY: tracing records prompts and completions. It must stay opt-in per
    // call site; a global `registerTelemetry()` would capture every AI SDK call
    // in the process (e.g. user chat routes).
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
    await generateText({ model: model(), prompt: 'traced', ...aiTelemetry('test.traced') });
    exporter.reset();

    await generateText({ model: model(), prompt: 'private prompt' });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
