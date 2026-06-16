/**
 * Vercel AI SDK telemetry helper.
 *
 * The AI SDK emits `gen_ai.*` OpenTelemetry spans (model, token usage, and —
 * with `recordInputs`/`recordOutputs` — the prompt + completion) only when a
 * call passes `experimental_telemetry: { isEnabled: true }`. Rather than stamp
 * that object across every call site, this single helper centralizes the
 * policy and is spread into the provider-neutral `LanguageModelAdapter`.
 *
 * Gated on `OTEL_EXPORTER_OTLP_ENDPOINT`: with no OTel backend configured it
 * returns an empty object, so the SDK call is untouched and nothing is
 * recorded — same no-op discipline as `@arki/meter/otel` and the DOT kernel.
 * The recorded inputs/outputs are exactly what makes a silent mid-chain
 * generation failure visible in the trace instead of a guessing game.
 */

import type { TelemetrySettings } from 'ai';

/**
 * Build the `experimental_telemetry` fragment for an AI SDK call, or `{}` when
 * telemetry is disabled. Spread the result into the call options:
 *
 * ```ts
 * await generateText({ model, prompt, ...aiTelemetry('ollama.generateText') });
 * ```
 *
 * @param functionId stable label for this generation, surfaced on the span so
 *   backends can group runs (e.g. `ollama.generateStructuredData`).
 */
export function aiTelemetry(
  functionId?: string,
): { experimental_telemetry: TelemetrySettings } | Record<string, never> {
  if (!process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) return {};
  return {
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: true,
      recordOutputs: true,
      ...(functionId ? { functionId } : {}),
    },
  };
}
