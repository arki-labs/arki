'use client';

import { useCallback, useRef, useState } from 'react';

export type SwipeDirection = 'up' | 'down' | 'left' | 'right' | 'tap';

type SwipeGestureOptions = {
  threshold?: number;
  swipeVelocity?: number;
  onSwipe?: (direction: SwipeDirection, deltaX: number, deltaY: number) => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onTap?: () => void;
}

type TouchPoint = {
  x: number;
  y: number;
  time: number;
}

/**
 * Hook for detecting swipe gestures on touch devices
 * Useful for quick number entry and navigation
 */
export function useSwipeGesture(options: SwipeGestureOptions = {}) {
  const {
    threshold = 30,
    swipeVelocity = 0.3,
    onSwipe,
    onSwipeUp,
    onSwipeDown,
    onSwipeLeft,
    onSwipeRight,
    onTap,
  } = options;

  const [isSwipping, setIsSwipping] = useState(false);
  const touchStart = useRef<TouchPoint | null>(null);
  const touchEnd = useRef<TouchPoint | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchStart.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
    touchEnd.current = null;
    setIsSwipping(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStart.current) return;

    const touch = e.touches[0];
    if (!touch) return;
    touchEnd.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
  }, []);

  const handleTouchEnd = useCallback((_e: React.TouchEvent) => {
    if (!touchStart.current) return;

    // If no move occurred, treat as tap
    if (!touchEnd.current) {
      onTap?.();
      setIsSwipping(false);
      touchStart.current = null;
      return;
    }

    const deltaX = touchEnd.current.x - touchStart.current.x;
    const deltaY = touchEnd.current.y - touchStart.current.y;
    const deltaTime = touchEnd.current.time - touchStart.current.time;
    
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    
    // Calculate velocity (pixels per millisecond)
    const velocityX = absX / deltaTime;
    const velocityY = absY / deltaTime;

    // Check if the swipe meets threshold and velocity requirements
    const isValidSwipe = (
      (absX > threshold || absY > threshold) &&
      (velocityX > swipeVelocity || velocityY > swipeVelocity)
    );

    if (isValidSwipe) {
      // Determine swipe direction
      let direction: SwipeDirection;
      
      if (absX > absY) {
        direction = deltaX > 0 ? 'right' : 'left';
      } else {
        direction = deltaY > 0 ? 'down' : 'up';
      }

      // Trigger callbacks
      onSwipe?.(direction, deltaX, deltaY);
      
      switch (direction) {
        case 'up': {
          onSwipeUp?.();
          break;
        }
        case 'down': {
          onSwipeDown?.();
          break;
        }
        case 'left': {
          onSwipeLeft?.();
          break;
        }
        case 'right': {
          onSwipeRight?.();
          break;
        }
      }
    } else {
      onTap?.();
    }

    // Reset state
    setIsSwipping(false);
    touchStart.current = null;
    touchEnd.current = null;
  }, [threshold, swipeVelocity, onSwipe, onSwipeUp, onSwipeDown, onSwipeLeft, onSwipeRight, onTap]);

  const handlers = {
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
  };

  return {
    handlers,
    isSwipping,
  };
}

/**
 * Hook for number pad swipe input
 * Maps swipe patterns to numbers 1-9
 */
export function useNumberSwipeGesture(onNumberSelect: (num: number) => void) {
  // Number pad layout:
  // 1 2 3
  // 4 5 6
  // 7 8 9
  
  const getNumberFromSwipePattern = useCallback((
    startZone: number,
    direction: SwipeDirection
  ): number | null => {
    const swipeMap: Record<number, Record<SwipeDirection, number>> = {
      // From center (5)
      5: {
        up: 2,
        down: 8,
        left: 4,
        right: 6,
        tap: 5,
      },
      // From corners and edges
      1: { right: 2, down: 4, tap: 1, up: 1, left: 1 },
      2: { left: 1, right: 3, down: 5, tap: 2, up: 2 },
      3: { left: 2, down: 6, tap: 3, up: 3, right: 3 },
      4: { up: 1, right: 5, down: 7, tap: 4, left: 4 },
      6: { up: 3, left: 5, down: 9, tap: 6, right: 6 },
      7: { up: 4, right: 8, tap: 7, down: 7, left: 7 },
      8: { up: 5, left: 7, right: 9, tap: 8, down: 8 },
      9: { up: 6, left: 8, tap: 9, down: 9, right: 9 },
    };

    return swipeMap[startZone]?.[direction] || null;
  }, []);

  const getZoneFromPosition = useCallback((x: number, y: number, bounds: DOMRect): number => {
    const relX = (x - bounds.left) / bounds.width;
    const relY = (y - bounds.top) / bounds.height;
    
    const col = Math.floor(relX * 3) + 1;
    const row = Math.floor(relY * 3);
    
    return Math.min(9, Math.max(1, row * 3 + col));
  }, []);

  const handleSwipeOnElement = useCallback((
    element: HTMLElement,
    startX: number,
    startY: number,
    direction: SwipeDirection
  ) => {
    const bounds = element.getBoundingClientRect();
    const startZone = getZoneFromPosition(startX, startY, bounds);
    const number = getNumberFromSwipePattern(startZone, direction);
    
    if (number !== null) {
      onNumberSelect(number);
    }
  }, [getZoneFromPosition, getNumberFromSwipePattern, onNumberSelect]);

  return {
    handleSwipeOnElement,
    getZoneFromPosition,
  };
}