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

async function requestJSON(url: string | URL, init: RequestInit, byteLimit: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Preparation provider HTTP ${response.status}`);
    if (!response.body) throw new Error('Preparation provider returned no body');
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > byteLimit) throw new Error('Preparation provider response exceeds byte limit');
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeDiarizedAudio(
  bytes: Uint8Array,
  input: TranscriptionOptions,
  signal?: AbortSignal,
): Promise<DiarizedTranscript> {
  const options = transcriptionOptionsSchema.parse(input);
  if (!bytes.byteLength) throw new Error('Audio is empty');
  const url = new URL('https://api.deepgram.com/v1/listen');
  for (const [key, value] of Object.entries({
    model: options.transcriptionModel,
    diarize: 'true',
    utterances: 'true',
    detect_language: 'true',
    smart_format: 'true',
  }))
    url.searchParams.set(key, value);
  const raw = deepgramResponseSchema.parse(
    await requestJSON(
      url,
      {
        method: 'POST',
        signal,
        headers: { Authorization: `Token ${options.deepgramKey}`, 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
      },
      8 * 1024 * 1024,
    ),
  );
  return diarizedTranscriptSchema.parse({
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
}
