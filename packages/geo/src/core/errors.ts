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
 * Error thrown when coordinates are invalid
 */
export class InvalidCoordinatesError extends GeoError {
  constructor(message: string, cause?: unknown) {
    super(message, 'INVALID_COORDINATES', cause);
    this.name = 'InvalidCoordinatesError';
  }
}

/**
 * Error thrown when geocoding fails
 */
export class GeocodingError extends GeoError {
  constructor(
    message: string,
    public readonly provider?: string,
    cause?: unknown,
  ) {
    super(message, 'GEOCODING_ERROR', cause);
    this.name = 'GeocodingError';
  }
}

/**
 * Error thrown when a lookup is cancelled through its `AbortSignal`.
 * Remediation: this is not a failure of the providers. Do not retry unless
 * the caller still wants the result; pass a fresh signal if it does.
 */
export class GeocodingAbortedError extends GeoError {
  constructor(message = 'Geocoding was aborted by the caller', cause?: unknown) {
    super(message, 'GEOCODING_ABORTED', cause);
    this.name = 'GeocodingAbortedError';
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
