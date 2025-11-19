/**
 * Service metrics tracking for monitoring and optimization
 * Tracks initialization time, access patterns, and provides recommendations
 */

import { debugContext } from '../debug.ts';

export type ServiceMetric = {
  name: string;
  initTimeMs: number | null;
  accessCount: number;
  ageMs: number | null;
  initialized: boolean;
};

export type MetricsReport = {
  totalServices: number;
  initializedServices: number;
  totalAccessCount: number;
  avgInitTimeMs: number;
  recommendations: string[];
  services: ServiceMetric[];
};

export class ServiceMetricsCollector {
  private metrics = new Map<string, ServiceMetric>();

  /**
   * Record a service metric
   */
  record(metric: ServiceMetric): void {
    this.metrics.set(metric.name, metric);
    debugContext(
      '[MetricsCollector] Recorded metric for service %s (initTime: %s, accessCount: %d, initialized: %s)',
      metric.name,
      metric.initTimeMs === null ? 'unknown' : `${metric.initTimeMs}ms`,
      metric.accessCount,
      metric.initialized,
    );
  }

  /**
   * Update access count for a service
   */
  incrementAccess(name: string): void {
    const metric = this.metrics.get(name);
    if (metric) {
      metric.accessCount++;
      debugContext('[MetricsCollector] Incremented access count for service %s (count: %d)', name, metric.accessCount);
    } else {
      debugContext('[MetricsCollector] Cannot increment access for unknown service: %s', name);
    }
  }

  /**
   * Get metric for a specific service
   */
  get(name: string): ServiceMetric | undefined {
    const metric = this.metrics.get(name);
    debugContext('[MetricsCollector] Getting metric for service %s (found: %s)', name, !!metric);
    return metric;
  }

  /**
   * Get all metrics
   */
  getAll(): ServiceMetric[] {
    const metrics = [...this.metrics.values()];
    debugContext('[MetricsCollector] Getting all metrics (count: %d)', metrics.length);
    return metrics;
  }

  /**
   * Generate a comprehensive metrics report with recommendations
   */
  generateReport(): MetricsReport {
    debugContext('[MetricsCollector] Generating comprehensive metrics report');
    const services = this.getAll();
    const initialized = services.filter(s => s.initialized);
    const totalAccess = services.reduce((sum, s) => sum + s.accessCount, 0);
    const avgInit =
      initialized.length > 0 ? initialized.reduce((sum, s) => sum + (s.initTimeMs ?? 0), 0) / initialized.length : 0;

    debugContext(
      '[MetricsCollector] Report stats: %d total services, %d initialized, %d total accesses, %.2f avg init time',
      services.length,
      initialized.length,
      totalAccess,
      avgInit,
    );

    const recommendations: string[] = [];

    // Analyze patterns and generate recommendations
    const unused = services.filter(s => s.initialized && s.accessCount === 0);
    if (unused.length > 0) {
      const recommendation = `${unused.length} service(s) initialized but never accessed: ${unused.map(s => s.name).join(', ')}`;
      recommendations.push(recommendation);
      debugContext('[MetricsCollector] Recommendation: %s', recommendation);
    }

    const lowUsage = services.filter(s => s.initialized && s.accessCount > 0 && s.accessCount < 5);
    if (lowUsage.length > 0) {
      const recommendation = `${lowUsage.length} service(s) with low usage (<5 accesses): ${lowUsage.map(s => s.name).join(', ')} - consider lazy initialization`;
      recommendations.push(recommendation);
      debugContext('[MetricsCollector] Recommendation: %s', recommendation);
    }

    const slowInit = initialized.filter(s => (s.initTimeMs ?? 0) > 100);
    if (slowInit.length > 0) {
      const recommendation = `${slowInit.length} service(s) with slow initialization (>100ms): ${slowInit.map(s => `${s.name} (${s.initTimeMs}ms)`).join(', ')}`;
      recommendations.push(recommendation);
      debugContext('[MetricsCollector] Recommendation: %s', recommendation);
    }

    const uninitialized = services.filter(s => !s.initialized);
    if (uninitialized.length > 0) {
      const recommendation = `${uninitialized.length} service(s) not yet initialized: ${uninitialized.map(s => s.name).join(', ')}`;
      recommendations.push(recommendation);
      debugContext('[MetricsCollector] Recommendation: %s', recommendation);
    }

    debugContext('[MetricsCollector] Report complete with %d recommendation(s)', recommendations.length);

    return {
      totalServices: services.length,
      initializedServices: initialized.length,
      totalAccessCount: totalAccess,
      avgInitTimeMs: Math.round(avgInit * 100) / 100,
      recommendations,
      services: [...services].sort((a: ServiceMetric, b: ServiceMetric) => b.accessCount - a.accessCount),
    };
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    const count = this.metrics.size;
    this.metrics.clear();
    debugContext('[MetricsCollector] Cleared %d metric(s)', count);
  }

  /**
   * Export metrics in JSON format
   */
  toJSON(): Record<string, ServiceMetric> {
    const json = Object.fromEntries(this.metrics.entries());
    debugContext('[MetricsCollector] Exported %d metric(s) to JSON', this.metrics.size);
    return json;
  }
}

/**
 * Global metrics collector singleton
 * Applications can import and use this for centralized metrics
 */
export const globalMetrics = new ServiceMetricsCollector();
