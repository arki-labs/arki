/**
 * Google Marker component type definitions
 */

import type { ReactNode } from 'react';

import type { Coordinates } from '../../../core/types';
import type { AdvancedMarkerProps, PinProps } from './primitives';

/**
 * Google Marker configuration
 */
export interface GoogleMarkerProps extends Omit<AdvancedMarkerProps, 'position'> {
  /**
   * Marker position coordinates
   */
  position: Coordinates;

  /**
   * Called when marker is clicked
   */
  onClick?: () => void;

  /**
   * Marker content (e.g., Pin, custom HTML)
   */
  children?: ReactNode;

  /**
   * z-index for stacking order
   */
  zIndex?: number;

  /**
   * Additional className for styling
   */
  className?: string;
}

/**
 * Google Pin configuration (marker visual)
 */
export interface GooglePinProps extends PinProps {
  /**
   * Pin background color
   */
  background?: string;

  /**
   * Pin border color
   */
  borderColor?: string;

  /**
   * Pin glyph color (icon/text inside)
   */
  glyphColor?: string;

  /**
   * Pin scale (size multiplier)
   */
  scale?: number;

  /**
   * Additional className for styling
   */
  className?: string;
}

/**
 * Marker with metadata (for ResultsMap, etc.)
 */
export interface MarkerInfo<T = unknown> {
  /**
   * Unique identifier
   */
  id: string;

  /**
   * Marker position
   */
  position: Coordinates;

  /**
   * Optional label/title
   */
  label?: string;

  /**
   * Optional color
   */
  color?: string;

  /**
   * Optional image URL
   */
  imageUrl?: string;

  /**
   * Additional metadata
   */
  metadata?: T;
}
