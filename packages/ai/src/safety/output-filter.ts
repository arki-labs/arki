/**
 * Output Content Filter
 *
 * Provides pattern-based content analysis for LLM outputs.
 * Applications can configure custom patterns and thresholds
 * for domain-specific content filtering.
 *
 * @module safety/output-filter
 */

import type {
  ContentFilterResult,
  ContentPattern,
  ContentRating,
  FlaggedSegment,
  OutputFilterConfig,
  SuggestedEdit,
} from './types';
import { DEFAULT_OUTPUT_FILTER_CONFIG } from './types';

// ============================================
// OutputContentFilter Class
// ============================================

/**
 * Base output content filter for analyzing LLM-generated content.
 *
 * Provides a configurable framework for:
 * - Pattern-based content scoring across categories
 * - Threshold-based rating (safe/needs_review/blocked)
 * - Flagged segment identification
 * - Suggested edit generation
 *
 * Applications configure this with their own patterns and thresholds
 * for domain-specific content filtering.
 *
 * @example
 * ```typescript
 * const filter = new OutputContentFilter({
 *   categoryPatterns: {
 *     violence: [
 *       { pattern: /\bfight\w*\b/gi, weight: 0.5, description: 'Physical conflict' },
 *     ],
 *     profanity: [
 *       { pattern: /\bdamn\b/gi, weight: 0.3, description: 'Mild profanity' },
 *     ],
 *   },
 *   thresholds: {
 *     violence: 0.3,
 *     profanity: 0.2,
 *   },
 *   replacements: [
 *     { original: 'fight', replacement: 'disagree' },
 *   ],
 * });
 *
 * const result = filter.analyze('The characters fight over the prize.');
 * ```
 */
export class OutputContentFilter<TCategory extends string = string> {
  private readonly config: Required<OutputFilterConfig<TCategory>>;
  private readonly categories: TCategory[];
  private readonly replacementMap: Map<string, string>;

  /**
   * Creates a new OutputContentFilter instance.
   *
   * @param config - Configuration with patterns, thresholds, and replacements
   */
  constructor(config: OutputFilterConfig<TCategory>) {
    this.config = {
      categoryPatterns: config.categoryPatterns,
      thresholds: config.thresholds,
      blockingMultiplier: config.blockingMultiplier ?? DEFAULT_OUTPUT_FILTER_CONFIG.blockingMultiplier,
      replacements: config.replacements ?? [],
    };

    this.categories = Object.keys(config.categoryPatterns) as TCategory[];

    // Build replacement map for efficient lookups
    this.replacementMap = new Map(this.config.replacements.map(r => [r.original.toLowerCase(), r.replacement]));
  }

  /**
   * Analyzes content and returns a comprehensive filter result.
   *
   * @param content - The generated content to analyze
   * @returns A ContentFilterResult with ratings, scores, and suggestions
   */
  public analyze(content: string): ContentFilterResult<TCategory, Record<TCategory, number>> {
    // Calculate category scores
    const scores = this.calculateScores(content);

    // Check if content passes thresholds
    const passesThresholds = this.checkThresholds(scores);

    // Find flagged segments
    const flaggedSegments = this.findFlaggedSegments(content, scores);

    // Generate suggested edits
    const suggestedEdits = this.generateSuggestedEdits(flaggedSegments);

    // Determine overall rating
    const rating = this.determineRating(scores);

    return {
      rating,
      scores,
      passesThresholds,
      flaggedSegments,
      suggestedEdits,
      originalContent: content,
      timestamp: new Date(),
    };
  }

  /**
   * Quick check to determine if content would likely be blocked.
   * Useful for early rejection before full analysis.
   *
   * @param content - The content to check
   * @returns True if the content would likely be blocked
   */
  public wouldBlock(content: string): boolean {
    const scores = this.calculateScores(content);
    return this.determineRating(scores) === 'blocked';
  }

  /**
   * Applies suggested edits to content and returns the modified version.
   *
   * @param content - The original content
   * @param edits - The suggested edits to apply
   * @returns The modified content with edits applied
   */
  public applyEdits(content: string, edits: SuggestedEdit[]): string {
    // Sort edits by start index in descending order to apply from end to start
    const sortedEdits = [...edits].sort((a, b) => b.startIndex - a.startIndex);

    let result = content;
    for (const edit of sortedEdits) {
      result = result.slice(0, edit.startIndex) + edit.replacement + result.slice(edit.endIndex);
    }

    return result;
  }

  /**
   * Gets the configured thresholds.
   *
   * @returns The threshold configuration
   */
  public getThresholds(): Record<TCategory, number> {
    return { ...this.config.thresholds };
  }

  /**
   * Gets the categories being analyzed.
   *
   * @returns Array of category names
   */
  public getCategories(): TCategory[] {
    return [...this.categories];
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Calculates scores for each content category.
   */
  private calculateScores(content: string): Record<TCategory, number> {
    const normalizedContent = content.toLowerCase();
    const wordCount = content.split(/\s+/).length;

    const scores = {} as Record<TCategory, number>;

    for (const category of this.categories) {
      const patterns = this.config.categoryPatterns[category];
      const rawScore = this.calculatePatternScore(normalizedContent, patterns, wordCount);
      scores[category] = Math.min(rawScore, 1);
    }

    return scores;
  }

  /**
   * Calculates a weighted score based on pattern matches.
   */
  private calculatePatternScore(content: string, patterns: ContentPattern[], wordCount: number): number {
    let totalScore = 0;

    for (const { pattern, weight } of patterns) {
      const matches = content.match(pattern) || [];
      if (matches.length > 0) {
        // Each match contributes weighted score
        totalScore += matches.length * weight;
      }
    }

    // Normalize by word count to handle varying content lengths
    // Use a logarithmic scale to prevent very long content from being penalized too much
    const normalizer = Math.log10(Math.max(wordCount, 10));
    const normalizedScore = totalScore / normalizer;

    // Cap at 1.0 and apply diminishing returns for multiple matches
    return Math.tanh(normalizedScore * 0.5);
  }

  /**
   * Checks if content passes all configured thresholds.
   */
  private checkThresholds(scores: Record<TCategory, number>): boolean {
    for (const category of this.categories) {
      if (scores[category] > this.config.thresholds[category]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Finds and returns flagged segments in the content.
   */
  private findFlaggedSegments(content: string, scores: Record<TCategory, number>): FlaggedSegment<TCategory>[] {
    const segments: FlaggedSegment<TCategory>[] = [];

    for (const category of this.categories) {
      // Only flag if category score is above threshold
      if (scores[category] <= this.config.thresholds[category]) {
        continue;
      }

      const patterns = this.config.categoryPatterns[category];
      const threshold = this.config.thresholds[category];

      for (const { pattern, weight } of patterns) {
        // Only flag if the weight is above threshold for this category
        const relativeWeight = weight - threshold;
        if (relativeWeight <= 0) continue;

        const regex = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;

        while ((match = regex.exec(content)) !== null) {
          segments.push({
            text: match[0],
            category,
            confidence: Math.min(weight, 1),
            startIndex: match.index,
            endIndex: match.index + match[0].length,
            suggestedReplacement: this.getSuggestedReplacement(match[0].toLowerCase()),
          });
        }
      }
    }

    // Sort by position in content
    return segments.sort((a, b) => a.startIndex - b.startIndex);
  }

  /**
   * Gets a suggested replacement for a flagged word.
   */
  private getSuggestedReplacement(word: string): string | undefined {
    return this.replacementMap.get(word);
  }

  /**
   * Generates suggested edits based on flagged segments.
   */
  private generateSuggestedEdits(flaggedSegments: FlaggedSegment<TCategory>[]): SuggestedEdit[] {
    const edits: SuggestedEdit[] = [];

    for (const segment of flaggedSegments) {
      if (segment.suggestedReplacement) {
        edits.push({
          original: segment.text,
          replacement: this.preserveCase(segment.text, segment.suggestedReplacement),
          reason: `${segment.category} content flagged with ${Math.round(segment.confidence * 100)}% confidence`,
          startIndex: segment.startIndex,
          endIndex: segment.endIndex,
        });
      }
    }

    return edits;
  }

  /**
   * Preserves the case pattern of the original text in the replacement.
   */
  private preserveCase(original: string, replacement: string): string {
    if (original === original.toUpperCase()) {
      return replacement.toUpperCase();
    }
    if (original[0] === original[0]?.toUpperCase()) {
      return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    }
    return replacement.toLowerCase();
  }

  /**
   * Determines the overall content rating based on category scores.
   */
  private determineRating(scores: Record<TCategory, number>): ContentRating {
    const { thresholds, blockingMultiplier } = this.config;

    // Check for blocking conditions (significantly above thresholds)
    for (const category of this.categories) {
      if (scores[category] > thresholds[category] * blockingMultiplier) {
        return 'blocked';
      }
    }

    // Check for review conditions (above thresholds)
    for (const category of this.categories) {
      if (scores[category] > thresholds[category]) {
        return 'needs_review';
      }
    }

    return 'safe';
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Creates a new OutputContentFilter instance.
 *
 * @param config - Configuration with patterns, thresholds, and replacements
 * @returns Configured OutputContentFilter
 */
export function createOutputContentFilter<TCategory extends string>(
  config: OutputFilterConfig<TCategory>,
): OutputContentFilter<TCategory> {
  return new OutputContentFilter(config);
}
