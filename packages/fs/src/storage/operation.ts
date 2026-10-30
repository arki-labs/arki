import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

import { isFailure, UnexpectedDefect } from '@arki/failure';

import { StorageCancelled, StorageRejected, StorageUnavailable, StorageWriteUncertain } from './failures.js';

/** Source schema for error facts at the provider boundary, including Drizzle's cause envelope. */
const errorFacts = z.object({
  code: z.string().optional(),
  name: z.string().optional(),
  $metadata: z.object({ httpStatusCode: z.number().optional() }).optional(),
});
const causeEnvelope = z.object({ cause: z.unknown() });
const REFUSED = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOTDIR',
  'EISDIR',
  'ELOOP',
  'EINVAL',
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidRequest',
  'NoSuchBucket',
]);
const UNAVAILABLE = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EIO',
  'ENODEV',
  'ESTALE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'SlowDown',
  'ServiceUnavailable',
  'TimeoutError',
]);

export function storageErrorFacts(cause: unknown) {
  try {
    const seen = new Set<unknown>();
    for (let depth = 0; depth < 5 && !seen.has(cause); depth++) {
      seen.add(cause);
      const parsed = errorFacts.safeParse(cause);
      // A wrapper's generic Error.name is not a provider fact; its inner driver code still owns the outcome.
      if (
        parsed.success &&
        (parsed.data.code ||
          parsed.data.$metadata ||
          (parsed.data.name &&
            (REFUSED.has(parsed.data.name) ||
              UNAVAILABLE.has(parsed.data.name) ||
              ['NotFound', 'NoSuchKey', 'AbortError'].includes(parsed.data.name))))
      )
        return parsed.data;
      const envelope = causeEnvelope.safeParse(cause);
      if (!envelope.success) break;
      cause = envelope.data.cause;
    }
  } catch {
    /* A hostile provider accessor is not evidence of a known refusal. */
  }
  return;
}

export function storageReadFailure(error: unknown, signal?: AbortSignal) {
  const facts = storageErrorFacts(error);
  if (signal?.aborted || facts?.name === 'AbortError') return StorageCancelled({ cause: error });
  const code = facts?.code ?? facts?.name;
  const status = facts?.$metadata?.httpStatusCode;
  if ((code && REFUSED.has(code)) || (status !== undefined && status >= 400 && status < 500 && status !== 429))
    return StorageRejected({ cause: error });
  if ((code && UNAVAILABLE.has(code)) || status === 429 || (status !== undefined && status >= 500))
    return StorageUnavailable({ cause: error });
  return UnexpectedDefect({ cause: error });
}

export function storageWriteFailure(error: unknown) {
  const read = storageReadFailure(error);
  // A definite provider refusal is different from a missing acknowledgement after dispatch.
  if (StorageRejected.is(read)) return read;
  return StorageWriteUncertain({ cause: error });
}

function report(run: () => unknown): void {
  try {
    void Promise.resolve(run()).catch(() => {
      /* Reporting remains best effort. */
    });
  } catch {
    /* Reporting cannot own the operation. */
  }
}

/** No paths, keys, URLs, names or private causes are reported. SDKs remain application-owned. */
export async function observeFs<T>(operation: string, run: () => T | Promise<T>): Promise<T> {
  let span: ReturnType<ReturnType<typeof trace.getTracer>['startSpan']> | undefined;
  let execution: Promise<T> | undefined;
  const execute = () => (execution ??= Promise.resolve().then(run));
  const started = performance.now();
  report(() => {
    span = trace.getTracer('@arki/fs').startSpan(operation);
  });
  report(() => span && context.with(trace.setSpan(context.active(), span), execute));
  let code: string | undefined;
  try {
    const result = await execute();
    if (isFailure<unknown>(result)) code = result.code;
    return result;
  } catch (error) {
    code = UnexpectedDefect.code;
    throw error;
  } finally {
    if (code) {
      const failureCode = code;
      report(() => span?.setAttribute('failure.code', failureCode));
      report(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    }
    report(() => span?.end());
    // Metrics use the same bounded operation names and failure codes as the spans.
    report(() => {
      const meter = metrics.getMeter('@arki/fs');
      const attributes = { operation, 'failure.code': code ?? 'none' };
      meter.createCounter('fs.operations').add(1, attributes);
      meter
        .createHistogram('fs.operation.duration', { unit: 's' })
        .record((performance.now() - started) / 1000, attributes);
    });
  }
}

/** The operation owns otherwise unclassified policy, observer and implementation throws. */
export function executeFs<T>(operation: string, run: () => T | Promise<T>) {
  return observeFs(operation, async () => {
    try {
      return await run();
    } catch (error) {
      return UnexpectedDefect({ cause: error });
    }
  });
}
