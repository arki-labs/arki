/**
 * Base error class for all geo-related errors
 */
export class GeoError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GeoError';
  }
}

/**
 * Error thrown when map provider initialization fails
 */
export class MapProviderError extends GeoError {
  constructor(
    message: string,
    public readonly provider: string,
    cause?: unknown,
  ) {
    super(message, 'MAP_PROVIDER_ERROR', cause);
    this.name = 'MapProviderError';
  }
}

/**
 * Error thrown when bounds calculations fail
 */
export class BoundsError extends GeoError {
  constructor(message: string, cause?: unknown) {
    super(message, 'BOUNDS_ERROR', cause);
    this.name = 'BoundsError';
  }
}
