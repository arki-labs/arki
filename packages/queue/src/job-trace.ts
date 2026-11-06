/** Small W3C propagation carrier; SDK/exporter configuration remains app-owned. */
import type { Context } from '@opentelemetry/api';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { z } from 'zod';

const carrierSchema = z.record(z.string().max(128), z.string().max(4096));
const MAX_TRACE_BYTES = 4096;

export function captureJobTrace(): string | undefined {
  try {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    if (Object.keys(carrier).length === 0) return;
    const encoded = JSON.stringify(carrier);
    return encoded.length <= MAX_TRACE_BYTES ? encoded : undefined;
  } catch {
    return undefined;
  }
}

export function jobTraceOptions() {
  const metadata = captureJobTrace();
  return metadata === undefined ? {} : { telemetry: { metadata } };
}

export function extractJobTrace(metadata: string | undefined): Context | undefined {
  try {
    if (metadata === undefined || metadata.length > MAX_TRACE_BYTES) return;
    const value: unknown = JSON.parse(metadata);
    const carrier = carrierSchema.safeParse(value);
    // Extracted onto the root, never the active context: a carrier with no trace in it must not
    // hand back whatever span happens to be active in the worker.
    if (carrier.success) return propagation.extract(ROOT_CONTEXT, carrier.data);
  } catch {
    /* Broken telemetry must never reject a delivery. */
  }
  return undefined;
}
