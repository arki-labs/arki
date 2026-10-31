/**
 * Safety Module
 *
 * Provides input sanitization, output filtering, and safety utilities for AI/LLM operations.
 *
 * This module includes:
 * - **Prompt Injection Detection**: Detects attempts to manipulate LLM behavior
 * - **PII Redaction**: Detects and redacts personally identifiable information
 * - **Base Input Sanitizer**: Configurable sanitization pipeline for user inputs
 * - **Output Content Filter**: Configurable content analysis for LLM outputs
 *
 * @module safety
 *
 * ## Usage Examples
 *
 * ### Basic Input Sanitization
 *
 * ```typescript
 * import { createInputSanitizer } from '@arki/ai/safety';
 *
 * const sanitizer = createInputSanitizer();
 * const report = sanitizer.sanitize(userInput);
 *
 * if (report.result === 'blocked') {
 *   throw new Error(report.blockedReason);
 * }
 *
 * // Safe to use with LLM
 * const response = await llm.generate(report.sanitizedInput);
 * ```
 *
 * ### Output Content Filtering
 *
 * ```typescript
 * import { createOutputContentFilter } from '@arki/ai/safety';
 *
 * const filter = createOutputContentFilter({
 *   categoryPatterns: {
 *     violence: [
 *       { pattern: /\bfight\w*\b/gi, weight: 0.5, description: 'Conflict' },
 *     ],
 *   },
 *   thresholds: { violence: 0.3 },
 *   replacements: [{ original: 'fight', replacement: 'disagree' }],
 * });
 *
 * const result = filter.analyze(llmOutput);
 * if (result.rating === 'blocked') {
 *   // Content not appropriate, use suggested edits or regenerate
 * }
 * ```
 *
 * ### Prompt Injection Detection Only
 *
 * ```typescript
 * import { createPromptInjectionDetector } from '@arki/ai/safety';
 *
 * const detector = createPromptInjectionDetector();
 *
 * if (detector.hasInjection(userInput)) {
 *   throw new Error('Prompt injection detected');
 * }
 * ```
 *
 * ### PII Redaction Only
 *
 * ```typescript
 * import { createPIIRedactor } from '@arki/ai/safety';
 *
 * const redactor = createPIIRedactor();
 * const result = redactor.redact(userInput);
 *
 * console.log(result.redactedText); // PII replaced with placeholders
 * ```
 *
 * ### Custom Input Sanitizer Configuration
 *
 * ```typescript
 * import { createInputSanitizer } from '@arki/ai/safety';
 *
 * const sanitizer = createInputSanitizer({
 *   maxInputLength: 5000,
 *   detectPromptInjection: true,
 *   redactPII: true,
 *   customInjectionPatterns: [
 *     { pattern: /my-custom-pattern/i, description: 'Custom rule' }
 *   ],
 * });
 * ```
 *
 * ### Composing with Domain-Specific Sanitization
 *
 * ```typescript
 * import { BaseInputSanitizer } from '@arki/ai/safety';
 *
 * // Using composition (recommended)
 * class ChildrenContentSanitizer {
 *   private readonly baseSanitizer = new BaseInputSanitizer();
 *
 *   public sanitize(input: string) {
 *     // First, run base sanitization
 *     const report = this.baseSanitizer.sanitize(input);
 *     if (report.result === 'blocked') return report;
 *
 *     // Add domain-specific checks
 *     const contentIssues = this.checkChildrenContent(report.sanitizedInput);
 *     // ... handle content issues
 *
 *     return report;
 *   }
 * }
 * ```
 */

// ============================================
// Type Exports
// ============================================

export type {
  // Input sanitization types
  BaseIssueType,
  DetectionPattern,
  PIIPattern,
  SanitizationIssue,
  SanitizationReport,
  SanitizationResult,
  SanitizerConfig,
  // Output filtering types
  ContentFilterResult,
  ContentPattern,
  ContentRating,
  FlaggedSegment,
  OutputFilterConfig,
  ReplacementSuggestion,
  SuggestedEdit,
} from './types.js';

export { detectionPatternSchema, piiPatternSchema, sanitizerConfigSchema } from './schemas.js';
export {
  // Input sanitization constants
  BASE_ISSUE_TYPES,
  DEFAULT_SANITIZER_CONFIG,
  SANITIZATION_RESULTS,
  // Output filtering constants
  CONTENT_RATINGS,
  DEFAULT_OUTPUT_FILTER_CONFIG,
} from './types.js';

// ============================================
// Prompt Injection Detection
// ============================================

export {
  createPromptInjectionDetector,
  DEFAULT_INJECTION_PATTERNS,
  PromptInjectionDetector,
} from './prompt-injection.js';

// ============================================
// PII Redaction
// ============================================

export type { PIIRedactionResult } from './pii-redactor.js';

export {
  createPIIRedactor,
  DEFAULT_PII_PATTERNS,
  PIIRedactor,
} from './pii-redactor.js';

// ============================================
// Input Sanitization
// ============================================

export {
  BaseInputSanitizer,
  createInputSanitizer,
} from './input-sanitizer.js';

// ============================================
// Output Content Filtering
// ============================================

export {
  createOutputContentFilter,
  OutputContentFilter,
} from './output-filter.js';
