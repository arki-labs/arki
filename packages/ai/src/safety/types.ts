/**
 * Safety Types
 *
 * Type definitions for input sanitization and safety checks
 * for AI/LLM operations.
 *
 * @module safety/types
 */

import { z } from '@arki/contracts';

// ============================================
// Result Types
// ============================================

/**
 * Result of the sanitization process.
 * - clean: Input passed all checks without modification
 * - sanitized: Input was modified to remove problematic content
 * - blocked: Input was rejected entirely due to severe violations
 */
export const SANITIZATION_RESULTS = ['clean', 'sanitized', 'blocked'] as const;
export type SanitizationResult = (typeof SANITIZATION_RESULTS)[number];

// ============================================
// Issue Types
// ============================================

/**
 * Base categories of issues that can be found during input sanitization.
 * Applications can extend this with custom issue types.
 */
export const BASE_ISSUE_TYPES = [
  'prompt_injection',
  'pii_detected',
  'length_exceeded',
  'dangerous_characters',
] as const;
export type BaseIssueType = (typeof BASE_ISSUE_TYPES)[number];

/**
 * A single issue found during sanitization.
 */
export type SanitizationIssue<TIssueType extends string = BaseIssueType> = {
  /** The type of issue detected */
  type: TIssueType;
  /** Human-readable description of the issue */
  description: string;
  /** The specific text that triggered the issue, if applicable */
  matchedText?: string;
  /** Start position in the original input */
  startIndex?: number;
  /** End position in the original input */
  endIndex?: number;
}

/**
 * Complete report from the sanitization process.
 */
export type SanitizationReport<TIssueType extends string = BaseIssueType> = {
  /** The overall result of sanitization */
  result: SanitizationResult;
  /** The original input text before sanitization */
  originalInput: string;
  /** The sanitized input text (null if blocked) */
  sanitizedInput: string | null;
  /** List of all issues found during sanitization */
  issuesFound: SanitizationIssue<TIssueType>[];
  /** Reason for blocking (only present if result is 'blocked') */
  blockedReason: string | null;
  /** Timestamp of when sanitization was performed */
  timestamp: Date;
}

// ============================================
// Pattern Types
// ============================================

/**
 * A pattern used for detecting issues in input.
 */
export const detectionPatternSchema = z.object({
  /** Regular expression pattern to match */
  pattern: z.instanceof(RegExp),
  /** Human-readable description of what this pattern detects */
  description: z.string(),
});

export type DetectionPattern = z.infer<typeof detectionPatternSchema>;

/**
 * A pattern for PII detection with replacement text.
 */
export const piiPatternSchema = detectionPatternSchema.extend({
  /** Text to replace matched content with */
  replacement: z.string(),
});

export type PIIPattern = z.infer<typeof piiPatternSchema>;

// ============================================
// Configuration Types
// ============================================

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

export type SanitizerConfig = z.infer<typeof sanitizerConfigSchema>;

/**
 * Default configuration for the sanitizer.
 */
export const DEFAULT_SANITIZER_CONFIG: Required<
  Omit<SanitizerConfig, 'customInjectionPatterns' | 'customPIIPatterns'>
> = {
  maxInputLength: 10_000,
  detectPromptInjection: true,
  redactPII: true,
  stripDangerousCharacters: true,
  normalizeWhitespace: true,
};

// ============================================
// Output Content Filtering Types
// ============================================

/**
 * Rating assigned to generated content.
 * - safe: Content is appropriate for the target audience
 * - needs_review: Content may have issues requiring human review
 * - blocked: Content is not appropriate and should not be shown
 */
export const CONTENT_RATINGS = ['safe', 'needs_review', 'blocked'] as const;
export type ContentRating = (typeof CONTENT_RATINGS)[number];

/**
 * A pattern for content detection with weighting.
 */
export type ContentPattern = {
  /** Regular expression pattern to match */
  pattern: RegExp;
  /** Weight indicating severity (0-1, higher = more severe) */
  weight: number;
  /** Human-readable description of what this pattern detects */
  description: string;
}

/**
 * Suggested replacement for problematic content.
 */
export type ReplacementSuggestion = {
  /** The word or phrase to replace */
  original: string;
  /** The suggested replacement */
  replacement: string;
}

/**
 * A segment of content that was flagged during filtering.
 */
export type FlaggedSegment<TCategory extends string = string> = {
  /** The text that was flagged */
  text: string;
  /** The category that triggered the flag */
  category: TCategory;
  /** Confidence score for this detection (0-1) */
  confidence: number;
  /** Start position in the original content */
  startIndex: number;
  /** End position in the original content */
  endIndex: number;
  /** Suggested replacement text, if available */
  suggestedReplacement?: string;
}

/**
 * A suggested edit for improving content safety.
 */
export type SuggestedEdit = {
  /** The original text to be replaced */
  original: string;
  /** The suggested replacement */
  replacement: string;
  /** Reason for the suggested edit */
  reason: string;
  /** Start position in the original content */
  startIndex: number;
  /** End position in the original content */
  endIndex: number;
}

/**
 * Complete result from output content filtering.
 */
export type ContentFilterResult<
  TCategory extends string = string,
  TScores extends Record<string, number> = Record<string, number>,
> = {
  /** The overall rating of the content */
  rating: ContentRating;
  /** Detailed category scores */
  scores: TScores;
  /** Whether the content passes the configured thresholds */
  passesThresholds: boolean;
  /** List of specific segments that were flagged */
  flaggedSegments: FlaggedSegment<TCategory>[];
  /** Suggested edits to improve content safety */
  suggestedEdits: SuggestedEdit[];
  /** The original content that was analyzed */
  originalContent: string;
  /** Timestamp of when filtering was performed */
  timestamp: Date;
}

/**
 * Configuration for the output content filter.
 */
export type OutputFilterConfig<TCategory extends string = string> = {
  /** Patterns to detect for each category */
  categoryPatterns: Record<TCategory, ContentPattern[]>;
  /** Thresholds for each category (0-1, scores above this trigger flags) */
  thresholds: Record<TCategory, number>;
  /** Multiplier for blocking (scores above threshold * this are blocked) */
  blockingMultiplier?: number;
  /** Suggested replacements for specific words */
  replacements?: ReplacementSuggestion[];
}

/**
 * Default configuration values for output filter.
 */
export const DEFAULT_OUTPUT_FILTER_CONFIG = {
  blockingMultiplier: 2,
} as const;
