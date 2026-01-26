/**
 * Base Input Sanitizer
 *
 * Provides general-purpose input sanitization for LLM operations.
 * Applications can extend this class to add domain-specific sanitization.
 *
 * @module safety/input-sanitizer
 */

import { PIIRedactor } from './pii-redactor';
import { PromptInjectionDetector } from './prompt-injection';
import type {
  BaseIssueType,
  SanitizationIssue,
  SanitizationReport,
  SanitizationResult,
  SanitizerConfig,
} from './types';

// ============================================
// Constants
// ============================================

/** Characters to strip from input for safety */
const DANGEROUS_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// ============================================
// BaseInputSanitizer Class
// ============================================

/**
 * Base input sanitizer for LLM operations.
 *
 * Provides core sanitization capabilities:
 * - Prompt injection detection and blocking
 * - PII detection and redaction
 * - Dangerous character stripping
 * - Input length enforcement
 * - Whitespace normalization
 *
 * Applications should extend this class to add domain-specific
 * sanitization rules (e.g., content appropriateness for children).
 *
 * @example
 * ```typescript
 * // Basic usage
 * const sanitizer = new BaseInputSanitizer();
 * const report = sanitizer.sanitize('Hello, contact me at john@example.com');
 *
 * if (report.result === 'blocked') {
 *   throw new Error(report.blockedReason);
 * }
 *
 * // Use sanitizedInput for LLM
 * await llm.generate(report.sanitizedInput);
 * ```
 *
 * @example
 * ```typescript
 * // Custom configuration
 * const sanitizer = new BaseInputSanitizer({
 *   maxInputLength: 5000,
 *   redactPII: true,
 *   detectPromptInjection: true,
 * });
 * ```
 */
export class BaseInputSanitizer<TIssueType extends string = BaseIssueType> {
  protected readonly config: Required<
    Omit<SanitizerConfig, 'customInjectionPatterns' | 'customPIIPatterns'>
  >;
  protected readonly injectionDetector: PromptInjectionDetector;
  protected readonly piiRedactor: PIIRedactor;

  /**
   * Creates a new BaseInputSanitizer.
   *
   * @param config - Configuration options for sanitization
   */
  constructor(config?: SanitizerConfig) {
    this.config = {
      maxInputLength: config?.maxInputLength ?? 10000,
      detectPromptInjection: config?.detectPromptInjection ?? true,
      redactPII: config?.redactPII ?? true,
      stripDangerousCharacters: config?.stripDangerousCharacters ?? true,
      normalizeWhitespace: config?.normalizeWhitespace ?? true,
    };

    this.injectionDetector = new PromptInjectionDetector(
      config?.customInjectionPatterns
    );
    this.piiRedactor = new PIIRedactor(config?.customPIIPatterns);
  }

  /**
   * Sanitizes the input text and returns a comprehensive report.
   *
   * @param input - The raw user input to sanitize
   * @returns A SanitizationReport with the result and any issues found
   */
  public sanitize(input: string): SanitizationReport<TIssueType> {
    const issues: SanitizationIssue<TIssueType>[] = [];
    let sanitizedInput = input;
    let result: SanitizationResult = 'clean';

    // Step 1: Strip dangerous characters
    if (this.config.stripDangerousCharacters) {
      const original = sanitizedInput;
      sanitizedInput = this.stripDangerousCharacters(sanitizedInput);
      if (sanitizedInput !== original) {
        issues.push({
          type: 'dangerous_characters' as TIssueType,
          description: 'Dangerous control characters removed',
        });
        result = 'sanitized';
      }
    }

    // Step 2: Check input length
    if (sanitizedInput.length > this.config.maxInputLength) {
      issues.push({
        type: 'length_exceeded' as TIssueType,
        description: `Input exceeds maximum length of ${this.config.maxInputLength} characters`,
        startIndex: this.config.maxInputLength,
        endIndex: sanitizedInput.length,
      });
      sanitizedInput = sanitizedInput.slice(0, this.config.maxInputLength);
      result = 'sanitized';
    }

    // Step 3: Check for prompt injection
    if (this.config.detectPromptInjection) {
      const injectionIssues = this.injectionDetector.detect(sanitizedInput);
      if (injectionIssues.length > 0) {
        issues.push(...(injectionIssues as SanitizationIssue<TIssueType>[]));
        // Prompt injection always blocks the input
        return this.createReport(
          input,
          null,
          'blocked',
          issues,
          'Prompt injection attempt detected'
        );
      }
    }

    // Step 4: Detect and redact PII
    if (this.config.redactPII) {
      const piiResult = this.piiRedactor.redact(sanitizedInput);
      if (piiResult.hasPII) {
        issues.push(...(piiResult.issues as SanitizationIssue<TIssueType>[]));
        sanitizedInput = piiResult.redactedText;
        result = 'sanitized';
      }
    }

    // Step 5: Normalize whitespace
    if (this.config.normalizeWhitespace) {
      sanitizedInput = this.normalizeWhitespace(sanitizedInput);
    }

    // Final check: if input is essentially empty after sanitization
    if (sanitizedInput.trim().length === 0) {
      return this.createReport(
        input,
        null,
        'blocked',
        issues,
        'Input is empty or contains only blocked content'
      );
    }

    return this.createReport(input, sanitizedInput, result, issues, null);
  }

  /**
   * Quick check to see if an input is likely to be blocked.
   *
   * @param input - The input to check
   * @returns True if the input would likely be blocked
   */
  public wouldBlock(input: string): boolean {
    // Check for prompt injection
    if (this.config.detectPromptInjection) {
      if (this.injectionDetector.hasInjection(input)) {
        return true;
      }
    }

    // Empty input would be blocked
    if (input.trim().length === 0) {
      return true;
    }

    return false;
  }

  /**
   * Removes dangerous control characters from the input.
   */
  protected stripDangerousCharacters(input: string): string {
    return input.replace(DANGEROUS_CHARACTERS, '');
  }

  /**
   * Normalizes whitespace in the input.
   */
  protected normalizeWhitespace(input: string): string {
    return input
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/^\s+|\s+$/g, ''); // Trim leading and trailing whitespace
  }

  /**
   * Creates a standardized SanitizationReport.
   */
  protected createReport(
    originalInput: string,
    sanitizedInput: string | null,
    result: SanitizationResult,
    issuesFound: SanitizationIssue<TIssueType>[],
    blockedReason: string | null
  ): SanitizationReport<TIssueType> {
    return {
      result,
      originalInput,
      sanitizedInput,
      issuesFound,
      blockedReason,
      timestamp: new Date(),
    };
  }

  /**
   * Gets the current configuration.
   */
  public getConfig(): typeof this.config {
    return { ...this.config };
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Creates a new BaseInputSanitizer instance.
 *
 * @param config - Configuration options
 * @returns Configured BaseInputSanitizer
 */
export function createInputSanitizer(
  config?: SanitizerConfig
): BaseInputSanitizer {
  return new BaseInputSanitizer(config);
}
