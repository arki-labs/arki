/**
 * Mock Embedding Provider for testing and development
 * Generates deterministic embeddings based on text content
 */

import type { EmbeddingProvider } from '../../types';

export type MockEmbeddingConfig = {
  dimensions?: number;
  delay?: number; // Simulate API latency
  shouldFail?: boolean; // For testing error handling
  failureRate?: number; // Percentage of requests that should fail
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  private dimensions: number;
  private delay: number;
  private shouldFail: boolean;
  private failureRate: number;
  private cache = new Map<string, number[]>();

  constructor(config: MockEmbeddingConfig = {}) {
    this.dimensions = config.dimensions || 1536;
    this.delay = config.delay || 0;
    this.shouldFail = config.shouldFail || false;
    this.failureRate = config.failureRate || 0;
  }

  async getEmbedding(text: string): Promise<number[]> {
    // Simulate network delay
    if (this.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delay));
    }

    // Simulate failures for testing
    if (this.shouldFail || (this.failureRate > 0 && Math.random() < this.failureRate / 100)) {
      throw new Error('Mock embedding provider failed (simulated)');
    }

    // Check cache
    const cached = this.cache.get(text);
    if (cached) return cached;

    // Generate deterministic embedding based on text
    const embedding = this.generateEmbedding(text);
    this.cache.set(text, embedding);

    return embedding;
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.getEmbedding(text)));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private generateEmbedding(text: string): number[] {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const vector = new Array(this.dimensions).fill(0);

    // Create a hash-based embedding
    for (const [wordIndex, word] of words.entries()) {
      const hash = this.hashString(word);

      // Distribute word features across dimensions
      for (let i = 0; i < Math.min(20, this.dimensions); i++) {
        const index = (hash + i * 31) % this.dimensions;
        const weight = 1 / (wordIndex + 1); // Decay by position
        vector[index] += weight * (1 + (hash % 10) / 10);
      }
    }

    // Add some semantic features based on common patterns
    const semanticFeatures = this.extractSemanticFeatures(text);
    for (let i = 0; i < Math.min(semanticFeatures.length, this.dimensions); i++) {
      vector[i] += semanticFeatures[i]!;
    }

    // Add positional encoding
    for (let i = 0; i < this.dimensions; i++) {
      const freq = i / this.dimensions;
      vector[i] += Math.sin(freq * Math.PI) * 0.1;
    }

    // Normalize to unit vector
    const magnitude = Math.sqrt(
      vector.reduce((sum, val) => sum + val * val, 0)
    );
    return vector.map((val) => val / (magnitude || 1));
  }

  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  private extractSemanticFeatures(text: string) {
    const features = Array.from<number>({length: 100}).fill(0);
    const lowerText = text.toLowerCase();

    // Common semantic categories with weights
    const categories: Record<string, { keywords: string[]; weight: number }> = {
      question: {
        keywords: ['what', 'when', 'where', 'who', 'why', 'how', '?'],
        weight: 1.5,
      },
      positive: {
        keywords: ['good', 'great', 'excellent', 'best', 'love', 'happy', 'joy'],
        weight: 1.2,
      },
      negative: {
        keywords: ['bad', 'worst', 'terrible', 'hate', 'sad', 'angry', 'fear'],
        weight: 1.2,
      },
      technical: {
        keywords: ['code', 'api', 'database', 'function', 'algorithm', 'system'],
        weight: 1.3,
      },
      action: {
        keywords: ['create', 'update', 'delete', 'build', 'make', 'do', 'run'],
        weight: 1.1,
      },
    };

    for (const [categoryIndex, [ , { keywords, weight }]] of Object.entries(categories).entries()) {
      let categoryScore = 0;

      for (const keyword of keywords) {
        if (lowerText.includes(keyword)) {
          categoryScore += weight;
        }
      }

      if (categoryScore > 0) {
        features[categoryIndex * 10] = categoryScore;
        features[categoryIndex * 10 + 1] = categoryScore * 0.5;
        features[categoryIndex * 10 + 2] = categoryScore * 0.25;
      }
    }

    // Add text statistics as features
    const words = text.split(/\s+/);
    features[80] = text.length / 1000; // Text length normalized
    features[81] = words.length / 100; // Word count normalized
    features[82] = (text.match(/[.!?]/g) || []).length / 10; // Sentence count normalized
    features[83] = (text.match(/[A-Z]/g) || []).length / text.length; // Uppercase ratio

    return features;
  }

  /**
   * Generate a similarity score between two texts (for testing)
   */
  async cosineSimilarity(text1: string, text2: string): Promise<number> {
    const embedding1 = await this.getEmbedding(text1);
    const embedding2 = await this.getEmbedding(text2);

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < this.dimensions; i++) {
      dotProduct += embedding1[i]! * embedding2[i]!;
      magnitude1 += embedding1[i]! * embedding1[i]!;
      magnitude2 += embedding2[i]! * embedding2[i]!;
    }

    const magnitude = Math.sqrt(magnitude1) * Math.sqrt(magnitude2);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }
}

// Pre-defined embeddings for common test cases
export const TEST_EMBEDDINGS: Record<string, number[]> = {
  'hello world': [0.1, 0.2, 0.3], // Simplified for testing
  'test query': [0.4, 0.5, 0.6],
  // Add more as needed
};
