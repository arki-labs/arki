/**
 * useMapOverlay hook
 *
 * Manages state for collapsible, resizable, and fullscreen map overlays.
 */

'use client';

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

export type MapSize = {
  width: number;
  height: number;
};

export type UseMapOverlayReturn = {
  /**
   * Whether the map is currently expanded (on hover or pinned)
   */
  isMapExpanded: boolean;

  /**
   * Whether the map is pinned (stays expanded)
   */
  isMapPinned: boolean;

  /**
   * Whether the map is in fullscreen mode
   */
  isMapFullScreen: boolean;

  /**
   * Current map size
   */
  mapSize: MapSize;

  /**
   * Whether the map is currently being resized
   */
  isResizing: boolean;

  /**
   * Set fullscreen state
   */
  setIsMapFullScreen: (isFullScreen: boolean) => void;

  /**
   * Called when mouse enters the map area
   */
  handleMapMouseEnter: () => void;

  /**
   * Called when mouse leaves the map area
   */
  handleMapMouseLeave: () => void;

  /**
   * Toggle map pin state
   */
  handleToggleMapPin: () => void;

  /**
   * Toggle fullscreen mode
   */
  handleToggleFullScreen: () => void;

  /**
   * Start resizing the map
   */
  handleResizeStart: (e: React.MouseEvent, handle: string) => void;
};

export interface UseMapOverlayOptions {
  /**
   * Initial map width in pixels
   * @default 700
   */
  initialWidth?: number;

  /**
   * Initial map height in pixels
   * @default 500
   */
  initialHeight?: number;

  /**
   * Minimum map width in pixels
   * @default 400
   */
  minWidth?: number;

  /**
   * Minimum map height in pixels
   * @default 300
   */
  minHeight?: number;

  /**
   * Delay before collapsing the map after mouse leave (ms)
   * @default 150
   */
  collapseDelay?: number;
}

/**
 * Hook to manage map overlay state
 *
 * Provides state and handlers for:
 * - Expand/collapse on hover
 * - Pin to keep expanded
 * - Fullscreen mode
 * - Resizing with 8-point handles
 *
 * @param options Configuration options
 * @returns State and handlers for map overlay
 *
 * @example
 * ```tsx
 * function MyMapOverlay() {
 *   const {
 *     isMapExpanded,
 *     isMapPinned,
 *     isMapFullScreen,
 *     mapSize,
 *     isResizing,
 *     handleMapMouseEnter,
 *     handleMapMouseLeave,
 *     handleToggleMapPin,
 *     handleToggleFullScreen,
 *     handleResizeStart,
 *   } = useMapOverlay();
 *
 *   return (
 *     <div
 *       onMouseEnter={handleMapMouseEnter}
 *       onMouseLeave={handleMapMouseLeave}
 *       style={isMapFullScreen ? {} : { width: mapSize.width, height: mapSize.height }}
 *     >
 *       {// Map content}
 *     </div>
 *   );
 * }
 * ```
 */
export function useMapOverlay(options: UseMapOverlayOptions = {}): UseMapOverlayReturn {
  const {
    initialWidth = 700,
    initialHeight = 500,
    minWidth = 400,
    minHeight = 300,
    collapseDelay = 150,
  } = options;

  const [isMapExpanded, setIsMapExpanded] = useState(false);
  const [isMapPinned, setIsMapPinned] = useState(false);
  const [isMapFullScreen, setIsMapFullScreen] = useState(false);
  const [mapSize, setMapSize] = useState<MapSize>({ width: initialWidth, height: initialHeight });
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const collapseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (collapseTimeoutRef.current) {
        clearTimeout(collapseTimeoutRef.current);
      }
    };
  }, []);

  /**
   * Handle mouse enter - expand the map
   */
  const handleMapMouseEnter = useCallback(() => {
    if (collapseTimeoutRef.current) {
      clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }
    setIsMapExpanded(true);
  }, []);

  /**
   * Handle mouse leave - schedule collapse if not pinned
   */
  const handleMapMouseLeave = useCallback(() => {
    if (isMapPinned) {
      return;
    }

    collapseTimeoutRef.current = setTimeout(() => {
      setIsMapExpanded(false);
      collapseTimeoutRef.current = null;
    }, collapseDelay);
  }, [isMapPinned, collapseDelay]);

  /**
   * Toggle map pin state
   */
  const handleToggleMapPin = useCallback(() => {
    if (isMapPinned) {
      setIsMapPinned(false);
      setIsMapExpanded(false);
    } else {
      setIsMapPinned(true);
    }
  }, [isMapPinned]);

  /**
   * Toggle fullscreen mode
   */
  const handleToggleFullScreen = useCallback(() => {
    setIsMapFullScreen(!isMapFullScreen);
    if (!isMapFullScreen) {
      // Auto-pin when entering fullscreen
      setIsMapPinned(true);
    }
  }, [isMapFullScreen]);

  /**
   * Start resizing the map
   */
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, handle: string) => {
      e.preventDefault();
      e.stopPropagation();

      setIsResizing(true);
      setResizeHandle(handle);
      setResizeStart({
        x: e.clientX,
        y: e.clientY,
        width: mapSize.width,
        height: mapSize.height,
      });
    },
    [mapSize],
  );

  // Handle resize events
  useEffect(() => {
    if (!isResizing) return;

    const handleResizeMove = (e: MouseEvent) => {
      if (!resizeHandle) return;

      const deltaX = e.clientX - resizeStart.x;
      const deltaY = e.clientY - resizeStart.y;

      let newWidth = resizeStart.width;
      let newHeight = resizeStart.height;

      // Calculate new size based on resize handle direction
      if (resizeHandle.includes('e')) {
        newWidth = Math.max(minWidth, resizeStart.width + deltaX);
      }
      if (resizeHandle.includes('w')) {
        newWidth = Math.max(minWidth, resizeStart.width - deltaX);
      }
      if (resizeHandle.includes('s')) {
        newHeight = Math.max(minHeight, resizeStart.height + deltaY);
      }
      if (resizeHandle.includes('n')) {
        newHeight = Math.max(minHeight, resizeStart.height - deltaY);
      }

      setMapSize({ width: newWidth, height: newHeight });
    };

    const handleResizeEnd = () => {
      setIsResizing(false);
      setResizeHandle(null);
    };

    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);

    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };
  }, [isResizing, resizeHandle, resizeStart, minWidth, minHeight]);

  return {
    isMapExpanded,
    isMapPinned,
    isMapFullScreen,
    mapSize,
    isResizing,
    setIsMapFullScreen,
    handleMapMouseEnter,
    handleMapMouseLeave,
    handleToggleMapPin,
    handleToggleFullScreen,
    handleResizeStart,
  };
}
