/**
 * Service metrics tracking for monitoring and optimization
 * Tracks initialization time, access patterns, and provides recommendations
 */

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
  }

  /**
   * Update access count for a service
   */
  incrementAccess(name: string): void {
    const metric = this.metrics.get(name);
    if (metric) {
      metric.accessCount++;
    }
  }

  /**
   * Get metric for a specific service
   */
  get(name: string): ServiceMetric | undefined {
    return this.metrics.get(name);
  }

  /**
   * Get all metrics
   */
  getAll(): ServiceMetric[] {
    return [...this.metrics.values()];
  }

  /**
   * Generate a comprehensive metrics report with recommendations
   */
  generateReport(): MetricsReport {
    const services = this.getAll();
    const initialized = services.filter(s => s.initialized);
    const totalAccess = services.reduce((sum, s) => sum + s.accessCount, 0);
    const avgInit =
      initialized.length > 0
        ? initialized.reduce((sum, s) => sum + (s.initTimeMs ?? 0), 0) / initialized.length
        : 0;

    const recommendations: string[] = [];

    // Analyze patterns and generate recommendations
    const unused = services.filter(s => s.initialized && s.accessCount === 0);
    if (unused.length > 0) {
      recommendations.push(
        `${unused.length} service(s) initialized but never accessed: ${unused.map(s => s.name).join(', ')}`
      );
    }

    const lowUsage = services.filter(s => s.initialized && s.accessCount > 0 && s.accessCount < 5);
    if (lowUsage.length > 0) {
      recommendations.push(
        `${lowUsage.length} service(s) with low usage (<5 accesses): ${lowUsage.map(s => s.name).join(', ')} - consider lazy initialization`
      );
    }

    const slowInit = initialized.filter(s => (s.initTimeMs ?? 0) > 100);
    if (slowInit.length > 0) {
      recommendations.push(
        `${slowInit.length} service(s) with slow initialization (>100ms): ${slowInit.map(s => `${s.name} (${s.initTimeMs}ms)`).join(', ')}`
      );
    }

    const uninitialized = services.filter(s => !s.initialized);
    if (uninitialized.length > 0) {
      recommendations.push(
        `${uninitialized.length} service(s) not yet initialized: ${uninitialized.map(s => s.name).join(', ')}`
      );
    }

    return {
      totalServices: services.length,
      initializedServices: initialized.length,
      totalAccessCount: totalAccess,
      avgInitTimeMs: Math.round(avgInit * 100) / 100,
      recommendations,
      services: [...services].sort(
        (a: ServiceMetric, b: ServiceMetric) => b.accessCount - a.accessCount
      ),
    };
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics.clear();
  }

  /**
   * Export metrics in JSON format
   */
  toJSON(): Record<string, ServiceMetric> {
    return Object.fromEntries(this.metrics.entries());
  }
}

/**
 * Global metrics collector singleton
 * Applications can import and use this for centralized metrics
 */
export const globalMetrics = new ServiceMetricsCollector();
