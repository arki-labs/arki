import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CapturedSpan, SpanCapture } from '@arki/testing/otel';
import { captureSpans } from '@arki/testing/otel';

import { registerTelemetry } from '../sdk';
import { aiTelemetry } from './telemetry';

const PROMPT = 'private-prompt-ping';
const ANSWER = 'private-answer-pong';

function model(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: ANSWER }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

/** The root `gen_ai` span of the call labelled `functionId`. */
function rootOf(spans: readonly CapturedSpan[], functionId: string): CapturedSpan | undefined {
  return spans.find(span => span.attributes['gen_ai.agent.name'] === functionId);
}

/** Every attribute value on every span as text, to search for content that must not be there. */
function attributeText(spans: readonly CapturedSpan[]): string {
  return spans.flatMap(span => Object.values(span.attributes).map(value => String(value))).join('\n');
}

describe('aiTelemetry', () => {
  // One capture for the file: `@ai-sdk/otel` takes its tracer once, when the integration is built
  // at the first call, so a capture started per test would miss every later span.
  let spans: SpanCapture;
  beforeAll(() => {
    spans = captureSpans();
  });
  afterAll(() => {
    spans[Symbol.dispose]();
  });

  afterEach(() => {
    spans.reset();
    vi.unstubAllEnvs();
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
  });

  it('is a no-op when AI_TELEMETRY=off', async () => {
    // WHY: an app that must not put prompts into its traces needs one switch that turns the
    // spans off, even though a tracer provider is registered.
    vi.stubEnv('AI_TELEMETRY', 'off');

    expect(aiTelemetry('test.generateText')).toEqual({});
    await generateText({ model: model(), prompt: PROMPT, ...aiTelemetry('test.generateText') });

    expect(spans.finished).toHaveLength(0);
  });

  it('records spans with only an in-process tracer provider, no OTLP endpoint (A-36)', async () => {
    // WHY: an app that registers its own tracer provider (an X-ray panel, a test exporter) and no
    // OTLP exporter must still see AI spans. Gating on OTEL_EXPORTER_OTLP_ENDPOINT hid them.
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');

    await generateText({ model: model(), prompt: PROMPT, ...aiTelemetry('test.inProcess') });

    expect(rootOf(spans.finished, 'test.inProcess')?.attributes['gen_ai.usage.input_tokens']).toBe(3);
  });

  it('keeps the prompt and the model output off every span by default (A-36)', async () => {
    // WHY: prompts and model output carry user data. An app that registers a tracer provider for
    // latency and token usage must not ship its users' text to its trace backend without asking.

    await generateText({ model: model(), prompt: PROMPT, ...aiTelemetry('test.private') });

    const root = rootOf(spans.finished, 'test.private');
    expect(root?.attributes['gen_ai.usage.input_tokens']).toBe(3);
    expect(root?.attributes['gen_ai.input.messages']).toBeUndefined();
    expect(root?.attributes['gen_ai.output.messages']).toBeUndefined();
    const text = attributeText(spans.finished);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(ANSWER);
  });

  it('records the prompt and completion only after AI_TELEMETRY_RECORD_CONTENT=on', async () => {
    // WHY: the opt-in is how an app debugs a silent mid-chain generation failure from its traces.
    // It must put the content back, and only the exact value `on` may turn it on.
    vi.stubEnv('AI_TELEMETRY_RECORD_CONTENT', 'true');
    await generateText({ model: model(), prompt: PROMPT, ...aiTelemetry('test.notOptedIn') });
    expect(attributeText(spans.finished)).not.toContain(PROMPT);

    vi.stubEnv('AI_TELEMETRY_RECORD_CONTENT', 'on');
    await generateText({ model: model(), prompt: PROMPT, ...aiTelemetry('test.optedIn') });

    const root = rootOf(spans.finished, 'test.optedIn');
    expect(root?.attributes['gen_ai.input.messages']).toContain(PROMPT);
    expect(root?.attributes['gen_ai.output.messages']).toContain(ANSWER);
  });

  it('does not trace calls that do not spread the helper, even after it has been used', async () => {
    // WHY: tracing must stay limited to the call sites that spread the helper; a global
    // `registerTelemetry()` would trace every AI SDK call in the process (e.g. user chat routes).
    await generateText({ model: model(), prompt: 'traced', ...aiTelemetry('test.traced') });
    spans.reset();

    await generateText({ model: model(), prompt: PROMPT });

    expect(spans.finished).toHaveLength(0);
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

    await generateText({ model: model(), prompt: PROMPT, ...aiTelemetry('test.registered') });

    expect(calls).toEqual([{ provider: 'mock-provider', inputTokens: 3 }]);
    expect(rootOf(spans.finished, 'test.registered')).toBeDefined();
  });
});
