/**
 * Vercel AI SDK telemetry helper.
 *
 * Since AI SDK 7 the `ai` package no longer emits OpenTelemetry spans itself:
 * a call is traced only when an `@ai-sdk/otel` integration receives its
 * lifecycle events. That integration emits `gen_ai.*` spans (model, token
 * usage, and — with `recordInputs`/`recordOutputs` — the prompt + completion).
 * Rather than stamp that wiring across every call site, this single helper
 * centralizes the policy and is spread into the provider-neutral
 * `LanguageModelAdapter`.
 *
 * The integration is passed PER CALL, never registered globally with
 * `registerTelemetry()`. A global registration would make every AI SDK call
 * in the process record its prompt and completion; per-call keeps tracing
 * opt-in, limited to the call sites that spread this helper.
 *
 * The SDK uses a call's own `integrations` in place of the global ones. So the
 * fragment also lists every integration the app registered with
 * `registerTelemetry()` (`@arki/ai/sdk`), read at each call: the app's hooks see
 * every `@arki/ai` call, next to the spans.
 *
 * On by default. The integration reports to the global OpenTelemetry tracer provider, so spans
 * appear exactly when the app has registered one (an in-process tracer counts; no OTLP endpoint is
 * needed) and cost nothing more than no-op calls when it has not. `AI_TELEMETRY=off` turns it off:
 * the helper then returns an empty object and the SDK call is untouched. The recorded
 * inputs/outputs are exactly what makes a silent mid-chain generation failure visible in the
 * trace instead of a guessing game.
 */

import type { Telemetry, TelemetryOptions } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';

let integration: OpenTelemetry | undefined;

/** `AI_TELEMETRY=off` in the environment. Browsers and Hermes have no `process`, so it is on there. */
function telemetryOff(): boolean {
  return typeof process !== 'undefined' && process.env['AI_TELEMETRY'] === 'off';
}

/** The integrations the app registered with `registerTelemetry()`, at the moment of the call. */
function registeredIntegrations(): readonly Telemetry[] {
  return globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? [];
}

/**
 * Build the `telemetry` fragment for an AI SDK call, or `{}` when `AI_TELEMETRY=off`. Spread the result into the call options:
 *
 * ```ts
 * await generateText({ model, prompt, ...aiTelemetry('ollama.generateText') });
 * ```
 *
 * @param functionId stable label for this generation, surfaced on the span so
 *   backends can group runs (e.g. `ollama.generateStructuredData`).
 */
export function aiTelemetry(functionId?: string): { telemetry: TelemetryOptions } | Record<string, never> {
  if (telemetryOff()) return {};
  integration ??= new OpenTelemetry();
  return {
    telemetry: {
      recordInputs: true,
      recordOutputs: true,
      integrations: [integration, ...registeredIntegrations()],
      ...(functionId ? { functionId } : {}),
    },
  };
}
