/**
 * Google Marker component type definitions
 */

import type { ReactNode } from 'react';

import type { Coordinates } from '../../../core/types.js';
import type { AdvancedMarkerProps, PinProps } from './primitives.js';

/**
 * Google Marker configuration
 */
export type GoogleMarkerProps = {
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
} & Omit<AdvancedMarkerProps, 'position'>

/**
 * Google Pin configuration (marker visual)
 */
export type GooglePinProps = {
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
} & PinProps

/**
 * Marker with metadata (for ResultsMap, etc.)
 */
export type MarkerInfo<T = unknown> = {
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
