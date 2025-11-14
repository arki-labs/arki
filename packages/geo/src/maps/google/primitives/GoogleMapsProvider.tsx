/**
 * GoogleMapsProvider - Wrapper for APIProvider
 *
 * This component wraps @vis.gl/react-google-maps' APIProvider with:
 * - API key validation
 * - Error handling
 * - Loading state management
 */

import type { ReactNode } from 'react';
import { APIProvider } from '@vis.gl/react-google-maps';

export interface GoogleMapsProviderProps {
  /**
   * Google Maps API key (required)
   */
  apiKey: string;

  /**
   * Child components (maps, markers, etc.)
   */
  children: ReactNode;

  /**
   * Google Maps API version
   * @default 'weekly'
   */
  version?: string;

  /**
   * Additional Google Maps libraries to load
   * @default ['places', 'geometry']
   */
  libraries?: string[];

  /**
   * Called when the API fails to load
   */
  onLoadError?: (error: Error) => void;

  /**
   * Language for map text
   * @default 'en'
   */
  language?: string;

  /**
   * Region bias for results
   */
  region?: string;
}

/**
 * GoogleMapsProvider component
 *
 * Wraps APIProvider from @vis.gl/react-google-maps with validation and error handling.
 *
 * @example
 * ```tsx
 * <GoogleMapsProvider apiKey="YOUR_API_KEY">
 *   <GoogleMap center={{ lat: 0, lng: 0 }} zoom={2}>
 *     <GoogleMarker position={{ lat: 0, lng: 0 }} />
 *   </GoogleMap>
 * </GoogleMapsProvider>
 * ```
 */
export function GoogleMapsProvider({
  apiKey,
  children,
  version = 'weekly',
  libraries = ['places', 'geometry'],
  onLoadError,
  language = 'en',
  region,
}: GoogleMapsProviderProps) {
  // Validate API key
  if (!apiKey) {
    const error = new Error('Google Maps API key is required');
    console.error(error);
    onLoadError?.(error);

    return (
      <div className="flex items-center justify-center p-4 text-red-600">
        <p>Google Maps API key is missing. Please configure your environment variables.</p>
      </div>
    );
  }

  return (
    <APIProvider
      apiKey={apiKey}
      version={version}
      libraries={libraries}
      language={language}
      region={region}
      onLoad={() => {
        console.log('Google Maps API loaded successfully');
      }}
      onError={error => {
        console.error('Google Maps API failed to load:', error);
        onLoadError?.(error instanceof Error ? error : new Error(String(error)));
      }}
    >
      {children}
    </APIProvider>
  );
}
