/**
 * The runtime schemas of `./transcription`. Internal: `transcription.ts` declares its public types as the
 * source, so that entry carries no Zod; `transcription.test.ts` locks each schema to its type.
 */
import { z } from '@arki/contracts';

export const transcriptionOptionsSchema = z.object({
  deepgramKey: z.string().trim().min(1),
  transcriptionModel: z.string().trim().min(1).default('nova-3'),
});
export const diarizedTranscriptSchema = z
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
const time = z.number().finite().nonnegative();
export const deepgramResponseSchema = z.object({
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
