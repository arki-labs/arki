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
 * Gated on `OTEL_EXPORTER_OTLP_ENDPOINT`: with no OTel backend configured it
 * returns an empty object, so the SDK call is untouched and nothing is
 * recorded — same no-op discipline as `@arki/meter/otel` and the DOT kernel.
 * The recorded inputs/outputs are exactly what makes a silent mid-chain
 * generation failure visible in the trace instead of a guessing game.
 */

import type { TelemetryOptions } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';

let integration: OpenTelemetry | undefined;

/**
 * Build the `telemetry` fragment for an AI SDK call, or `{}` when telemetry is
 * disabled. Spread the result into the call options:
 *
 * ```ts
 * await generateText({ model, prompt, ...aiTelemetry('ollama.generateText') });
 * ```
 *
 * @param functionId stable label for this generation, surfaced on the span so
 *   backends can group runs (e.g. `ollama.generateStructuredData`).
 */
export function aiTelemetry(functionId?: string): { telemetry: TelemetryOptions } | Record<string, never> {
  // Browsers and Hermes have no `process`: no endpoint, so no telemetry.
  if (typeof process === 'undefined' || !process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) return {};
  integration ??= new OpenTelemetry();
  return {
    telemetry: {
      recordInputs: true,
      recordOutputs: true,
      integrations: [integration],
      ...(functionId ? { functionId } : {}),
    },
  };
}
