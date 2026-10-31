/**
 * PII Redaction
 *
 * Detects and redacts Personally Identifiable Information (PII) from text
 * before sending to LLMs.
 *
 * @module safety/pii-redactor
 */

import type { PIIPattern, SanitizationIssue } from './types.js';
import { scanRegex } from './scan-regex.js';

// ============================================
// Default PII Patterns
// ============================================

/**
 * Default patterns for detecting PII.
 * These patterns cover common PII types that should be redacted
 * before sending to external LLM services.
 */
export const DEFAULT_PII_PATTERNS: PIIPattern[] = [
  // Email addresses
  {
    pattern: /\b[\w.%+-]+@[A-Z0-9.-]+\.[A-Z|]{2,}\b/gi,
    replacement: '[EMAIL REDACTED]',
    description: 'Email address',
  },

  // Phone numbers (US format with variations)
  {
    pattern: /\b(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    replacement: '[PHONE REDACTED]',
    description: 'Phone number',
  },

  // Social Security Numbers (US)
  {
    pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
    replacement: '[SSN REDACTED]',
    description: 'Social Security Number',
  },

  // Credit card numbers (basic pattern)
  {
    pattern: /\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/g,
    replacement: '[CARD REDACTED]',
    description: 'Credit card number',
  },

  // US Street addresses (basic pattern)
  {
    pattern: /\b\d{1,5}\s[\w\s]+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl)[\s,]+(?:apt\.?\s*\d+[\s,]*)?[a-z]+,?\s*[a-z]{2}\s*\d{5}(?:-\d{4})?\b/gi,
    replacement: '[ADDRESS REDACTED]',
    description: 'Street address',
  },
];

// ============================================
// Result Types
// ============================================

/**
 * Result of PII detection and redaction.
 */
export type PIIRedactionResult = {
  /** The text with PII redacted */
  redactedText: string;
  /** List of issues found during redaction */
  issues: SanitizationIssue<'pii_detected'>[];
  /** Number of PII instances found */
  piiCount: number;
  /** Whether any PII was found */
  hasPII: boolean;
}

// ============================================
// PIIRedactor Class
// ============================================

/**
 * Detects and redacts Personally Identifiable Information from text.
 *
 * PII should be removed from user input before sending to external LLM
 * services to protect user privacy and comply with data protection regulations.
 *
 * @example
 * ```typescript
 * const redactor = new PIIRedactor();
 *
 * // Check for PII
 * if (redactor.hasPII('Contact me at john@example.com')) {
 *   console.log('Input contains PII');
 * }
 *
 * // Redact PII
 * const result = redactor.redact('My email is john@example.com');
 * console.log(result.redactedText); // "My email is [EMAIL REDACTED]"
 * ```
 */
export class PIIRedactor {
  private readonly patterns: PIIPattern[];
  /** Each pattern's scan copy (`g` set, `y` cleared), built once. */
  private readonly scans: { scan: RegExp; replacement: string; description: string }[];

  /**
   * Creates a new PIIRedactor.
   *
   * @param customPatterns - Additional patterns to include alongside defaults
   * @param replaceDefaults - If true, use only custom patterns (no defaults)
   */
  constructor(customPatterns?: PIIPattern[], replaceDefaults = false) {
    if (replaceDefaults && customPatterns) {
      this.patterns = customPatterns;
    } else if (customPatterns) {
      this.patterns = [...DEFAULT_PII_PATTERNS, ...customPatterns];
    } else {
      this.patterns = DEFAULT_PII_PATTERNS;
    }
    this.scans = this.patterns.map(({ pattern, replacement, description }) => ({
      scan: scanRegex(pattern),
      replacement,
      description,
    }));
  }

  /**
   * Detects and redacts PII from the input text.
   *
   * @param input - The text to check and redact
   * @returns Result containing redacted text and issues found
   */
  public redact(input: string): PIIRedactionResult {
    const issues: SanitizationIssue<'pii_detected'>[] = [];
    let redactedText = input;

    for (const { scan, replacement, description } of this.scans) {
      for (const match of input.matchAll(scan)) {
        issues.push({
          type: 'pii_detected',
          description: `${description} detected and redacted`,
          matchedText: match[0],
          startIndex: match.index,
          endIndex: match.index + match[0].length,
        });
      }

      // Apply the replacement to every match
      redactedText = redactedText.replace(scan, replacement);
    }

    return {
      redactedText,
      issues,
      piiCount: issues.length,
      hasPII: issues.length > 0,
    };
  }

  /**
   * Quick check to determine if input contains PII.
   *
   * @param input - The text to check
   * @returns True if any PII pattern matches
   */
  public hasPII(input: string): boolean {
    // `search` always starts at 0 and ignores `lastIndex`.
    return this.scans.some(({ scan }) => input.search(scan) !== -1);
  }

  /**
   * Detects PII without redacting (useful for validation).
   *
   * @param input - The text to check
   * @returns Array of issues found
   */
  public detect(input: string): SanitizationIssue<'pii_detected'>[] {
    const issues: SanitizationIssue<'pii_detected'>[] = [];

    for (const { scan, description } of this.scans) {
      for (const match of input.matchAll(scan)) {
        issues.push({
          type: 'pii_detected',
          description: `${description} detected`,
          matchedText: match[0],
          startIndex: match.index,
          endIndex: match.index + match[0].length,
        });
      }
    }

    return issues;
  }

  /**
   * Gets all patterns being used by this redactor.
   *
   * @returns Array of PII patterns
   */
  public getPatterns(): readonly PIIPattern[] {
    return this.patterns;
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Creates a new PIIRedactor instance.
 *
 * @param customPatterns - Additional patterns to include
 * @param replaceDefaults - If true, use only custom patterns
 * @returns Configured PIIRedactor
 */
export function createPIIRedactor(
  customPatterns?: PIIPattern[],
  replaceDefaults = false
): PIIRedactor {
  return new PIIRedactor(customPatterns, replaceDefaults);
}
