import { z } from '@arki/contracts';

const optionsSchema = z.object({
  deepgramKey: z.string().trim().min(1),
  transcriptionModel: z.string().trim().min(1).default('nova-3'),
});
const transcriptSchema = z
  .object({
    language: z.string().min(2),
    duration: z.number().finite().positive(),
    provider: z.literal('deepgram'),
    model: z.string(),
    segments: z
      .array(
        z.object({
          start: z.number().finite().nonnegative(),
          end: z.number().finite().nonnegative(),
          text: z.string().trim().min(1),
          speaker: z.string(),
          confidence: z.number().finite().min(0).max(1),
        }),
      )
      .min(1),
  })
  .superRefine((value, context) => {
    let previous = -1;
    for (const segment of value.segments) {
      if (segment.start < previous || segment.end <= segment.start || segment.end > value.duration)
        context.addIssue({ code: 'custom', message: 'Invalid transcript interval' });
      previous = segment.start;
    }
  });
export type DiarizedTranscript = z.infer<typeof transcriptSchema>;
const time = z.number().finite().nonnegative();
const deepgramSchema = z.object({
  metadata: z.object({ duration: z.number().finite().positive() }),
  results: z.object({
    channels: z.array(z.object({ detected_language: z.string().min(2) })).min(1),
    utterances: z
      .array(
        z.object({
          start: time,
          end: time,
          transcript: z.string().trim().min(1),
          speaker: z.number().int().nonnegative(),
          confidence: z.number().finite().min(0).max(1),
        }),
      )
      .min(1)
      .max(100000),
  }),
});
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
  input: z.input<typeof optionsSchema>,
  signal?: AbortSignal,
): Promise<DiarizedTranscript> {
  const options = optionsSchema.parse(input);
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
  const raw = deepgramSchema.parse(
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
  return transcriptSchema.parse({
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
