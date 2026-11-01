import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerTelemetry } from '../sdk';
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
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
  });

  afterAll(() => {
    trace.disable();
  });

  it('is a no-op when AI_TELEMETRY=off', async () => {
    // WHY: an app that must not put prompts into its traces needs one switch that turns the
    // spans off, even though a tracer provider is registered.
    vi.stubEnv('AI_TELEMETRY', 'off');

    expect(aiTelemetry('test.generateText')).toEqual({});
    await generateText({ model: model(), prompt: 'ping', ...aiTelemetry('test.generateText') });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('records spans with only an in-process tracer provider, no OTLP endpoint (A-36)', async () => {
    // WHY: an app that registers its own tracer provider (an X-ray panel, a test exporter) and no
    // OTLP exporter must still see AI spans. Gating on OTEL_EXPORTER_OTLP_ENDPOINT hid them.
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');

    await generateText({ model: model(), prompt: 'ping', ...aiTelemetry('test.inProcess') });

    const root = exporter.getFinishedSpans().find(span => span.attributes['gen_ai.agent.name'] === 'test.inProcess');
    expect(root?.attributes['gen_ai.usage.input_tokens']).toBe(3);
  });

  it('records the prompt, completion and function id on gen_ai spans', async () => {
    // WHY: AI SDK 7 stopped emitting spans from `ai` itself. Without the
    // `@ai-sdk/otel` integration this helper passes, traces silently go empty
    // and a mid-chain generation failure is invisible again.
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
    await generateText({ model: model(), prompt: 'traced', ...aiTelemetry('test.traced') });
    exporter.reset();

    await generateText({ model: model(), prompt: 'private prompt' });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('still calls the hooks the app registered with registerTelemetry, next to the spans', async () => {
    // WHY: the SDK uses a call's own integrations in place of the global ones. When every call
    // started passing the span integration, an app's `registerTelemetry` hook (provider, tokens,
    // cost per call) went silent. Both must fire.
    const calls: { provider: string; inputTokens: number | undefined }[] = [];
    registerTelemetry({
      onLanguageModelCallEnd: event => {
        calls.push({ provider: event.provider, inputTokens: event.usage.inputTokens });
      },
    });

    await generateText({ model: model(), prompt: 'ping', ...aiTelemetry('test.registered') });

    expect(calls).toEqual([{ provider: 'mock-provider', inputTokens: 3 }]);
    const root = exporter.getFinishedSpans().find(span => span.attributes['gen_ai.agent.name'] === 'test.registered');
    expect(root).toBeDefined();
  });
});
