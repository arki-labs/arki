import type { StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, isFailure, orThrow } from '@arki/failure';
import { formatIssues, parse } from '@arki/schema';

import { retryAfterMs } from './ai-service/provider-failure';
import { Cancelled, InvalidOutput, ProviderFailed, ProviderUnauthorized, RateLimited } from './failures';
import { deepgramResponseSchema, diarizedTranscriptSchema, transcriptionOptionsSchema } from './transcription-schemas';

/** Deepgram settings for one transcription. `transcriptionModel` defaults to `nova-3`. */
type TranscriptionOptions = { deepgramKey: string; transcriptionModel?: string };

/** A diarized transcript: timed, speaker-labelled segments in source order. */
export type DiarizedTranscript = {
  language: string;
  duration: number;
  provider: 'deepgram';
  model: string;
  segments: { start: number; end: number; text: string; speaker: string; confidence: number }[];
};

/**
 * Every way `transcribeDiarizedAudio` refuses: bad options or empty audio (`InvalidInput`), a Deepgram
 * 429 (`RateLimited`, with its Retry-After), 401/403 (`ProviderUnauthorized`), a response that is not
 * a valid transcript (`InvalidOutput`), any other status, network failure or timeout (`ProviderFailed`),
 * and the caller's abort (`Cancelled`).
 */
export type TranscriptionFailure =
  | ReturnType<typeof InvalidInput>
  | RateLimited
  | ProviderUnauthorized
  | InvalidOutput
  | ProviderFailed
  | Cancelled;

const TIMEOUT_MS = 180_000;
const BYTE_LIMIT = 8 * 1024 * 1024;

/** Which call failed, for the failure data. */
type DeepgramCall = { provider: 'deepgram'; model: string };

/** The failure for a fetch or body read that threw: the caller's abort, or a network failure or timeout. */
function requestFailure(error: unknown, call: DeepgramCall, signal: AbortSignal | undefined) {
  return signal?.aborted ? Cancelled({ cause: error }) : ProviderFailed(call, { cause: error });
}

/** The response body as JSON, refused when it is too large, not UTF-8 or not JSON. */
async function requestJSON(
  url: URL,
  init: RequestInit,
  call: DeepgramCall,
  signal: AbortSignal | undefined,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      return requestFailure(error, call, signal);
    }
    if (response.status === 429) {
      const wait = retryAfterMs(Object.fromEntries(response.headers));
      return RateLimited(wait === undefined ? {} : { retryAfterMs: wait });
    }
    if (response.status === 401 || response.status === 403)
      return ProviderUnauthorized({ ...call, status: response.status });
    if (!response.ok) return ProviderFailed({ ...call, status: response.status });
    if (!response.body) return InvalidOutput({ ...call, reason: 'the response has no body' });
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BYTE_LIMIT) return InvalidOutput({ ...call, reason: `the response exceeds ${BYTE_LIMIT} bytes` });
        parts.push(value);
      }
    } catch (error) {
      return requestFailure(error, call, signal);
    } finally {
      await reader.cancel().catch(() => {
        // Cancelling a body that already failed has nothing left to report.
      });
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    try {
      return { json: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
    } catch (error) {
      return InvalidOutput({ ...call, reason: 'the response is not UTF-8 JSON' }, { cause: error });
    }
  } finally {
    clearTimeout(timer);
  }
}

/** `parse` for a value the schema must accept: a refusal is the `InvalidInput`; a schema bug throws. */
function check<Output>(schema: StandardSchemaV1<unknown, Output>, value: unknown) {
  const result = parse(schema, value);
  return InvalidInput.is(result) ? result : orThrow(result);
}

/**
 * Transcribe audio with Deepgram, speaker-diarized. Returns the transcript, or a
 * {@link TranscriptionFailure}; it never throws for bad input or a Deepgram refusal.
 */
export async function transcribeDiarizedAudio(
  bytes: Uint8Array,
  input: TranscriptionOptions,
  signal?: AbortSignal,
): Promise<DiarizedTranscript | TranscriptionFailure> {
  const options = check(transcriptionOptionsSchema, input);
  if (isFailure(options)) return options;
  if (!bytes.byteLength) return InvalidInput({ issues: [{ message: 'Audio is empty', path: ['bytes'] }] });
  const call: DeepgramCall = { provider: 'deepgram', model: options.transcriptionModel };
  const url = new URL('https://api.deepgram.com/v1/listen');
  for (const [key, value] of Object.entries({
    model: options.transcriptionModel,
    diarize: 'true',
    utterances: 'true',
    detect_language: 'true',
    smart_format: 'true',
  }))
    url.searchParams.set(key, value);
  const body = await requestJSON(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Token ${options.deepgramKey}`, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    },
    call,
    signal,
  );
  if (isFailure(body)) return body;
  const raw = check(deepgramResponseSchema, body.json);
  if (isFailure(raw)) return InvalidOutput({ ...call, reason: formatIssues(raw.data.issues) }, { cause: raw });
  const transcript = check(diarizedTranscriptSchema, {
    language: raw.results.channels[0]!.detected_language,
    duration: raw.metadata.duration,
    segments: raw.results.utterances.map(segment => ({
      start: segment.start,
      end: segment.end,
      text: segment.transcript,
      speaker: `speaker-${segment.speaker}`,
      confidence: segment.confidence,
    })),
    provider: 'deepgram',
    model: options.transcriptionModel,
  });
  if (isFailure(transcript))
    return InvalidOutput({ ...call, reason: formatIssues(transcript.data.issues) }, { cause: transcript });
  return transcript;
}
