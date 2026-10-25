/**
 * The runtime schemas behind the sanitizer types in `./types`. `./types` holds the source types, so the
 * safety types carry no Zod; `zod.test.ts` locks each schema to its type.
 */
import { z } from '@arki/contracts';

/**
 * A pattern used for detecting issues in input.
 */
export const detectionPatternSchema = z.object({
  /** Regular expression pattern to match */
  pattern: z.instanceof(RegExp),
  /** Human-readable description of what this pattern detects */
  description: z.string(),
});

/**
 * A pattern for PII detection with replacement text.
 */
export const piiPatternSchema = detectionPatternSchema.extend({
  /** Text to replace matched content with */
  replacement: z.string(),
});

/**
 * Programmatic configuration for the base input sanitizer, including RegExp rules.
 */
export const sanitizerConfigSchema = z.object({
  /** Maximum allowed input length in characters */
  maxInputLength: z.number().min(1).optional(),
  /** Whether to detect and block prompt injection attempts */
  detectPromptInjection: z.boolean().optional(),
  /** Whether to detect and redact PII */
  redactPII: z.boolean().optional(),
  /** Whether to strip dangerous control characters */
  stripDangerousCharacters: z.boolean().optional(),
  /** Whether to normalize whitespace */
  normalizeWhitespace: z.boolean().optional(),
  /** Custom prompt injection patterns to add */
  customInjectionPatterns: z.array(detectionPatternSchema).optional(),
  /** Custom PII patterns to add */
  customPIIPatterns: z.array(piiPatternSchema).optional(),
});
