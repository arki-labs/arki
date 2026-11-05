/** Locks the public types of `@arki/testing/otel`: a lost parent type or a widened accessor fails typecheck. */
import type { Span } from '@opentelemetry/api';
import type { MetricData } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expectTypeOf } from 'vitest';

import type { CapturedSpan, SpanCapture } from './otel.js';
import { captureSpans } from './otel.js';

const spans = captureSpans();

expectTypeOf(spans).toEqualTypeOf<SpanCapture>();
expectTypeOf(spans).toExtend<Disposable>();
expectTypeOf(spans.finished).toEqualTypeOf<readonly CapturedSpan[]>();
expectTypeOf<SpanCapture['named']>().toEqualTypeOf<(name: string) => CapturedSpan>();
expectTypeOf<Parameters<SpanCapture['childrenOf']>>().toEqualTypeOf<[span: Pick<Span, 'spanContext'>]>();
expectTypeOf<ReturnType<SpanCapture['childrenOf']>>().toEqualTypeOf<readonly CapturedSpan[]>();
expectTypeOf<ReturnType<SpanCapture['collectMetrics']>>().toEqualTypeOf<Promise<readonly MetricData[]>>();
expectTypeOf<SpanCapture['reset']>().toEqualTypeOf<() => void>();

// A captured span is the SDK's span plus its parent, which is captured too.
expectTypeOf<CapturedSpan>().toExtend<ReadableSpan>();
expectTypeOf<CapturedSpan['parent']>().toEqualTypeOf<CapturedSpan | undefined>();
expectTypeOf(spans.named('db.transaction').parent?.name).toEqualTypeOf<string | undefined>();

// A live span from the API is accepted as a parent to look under.
declare const live: Span;
expectTypeOf(spans.childrenOf(live)).toEqualTypeOf<readonly CapturedSpan[]>();
