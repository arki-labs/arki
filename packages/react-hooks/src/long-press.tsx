'use client';

import { useCallback, useRef } from 'react';

type UseLongPressOptions = {
  onLongPress: () => void;
  onSinglePress?: () => void;
  delay?: number;
}

export function useLongPress({ onLongPress, onSinglePress, delay = 500 }: UseLongPressOptions) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressRef = useRef(false);

  const start = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      // Don't start long press timer on right click - let context menu handle it
      if ('button' in e && e.button === 2) {
        return;
      }

      isLongPressRef.current = false;
      timeoutRef.current = setTimeout(() => {
        isLongPressRef.current = true;
        onLongPress();
      }, delay);
    },
    [onLongPress, delay],
  );

  const stop = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't handle single press on right click - let context menu handle it
      if (e.button === 2) {
        return;
      }

      if (!isLongPressRef.current && onSinglePress) {
        onSinglePress();
      }
    },
    [onSinglePress],
  );

  const handleContextMenu = useCallback((_e: React.MouseEvent) => {
    // Don't prevent context menu - let it work normally
    // This allows right-click context menus to function properly
  }, []);

  const handlers = {
    onMouseDown: start,
    onMouseUp: stop,
    onMouseLeave: stop,
    onTouchStart: start,
    onTouchEnd: stop,
    onClick: handleClick,
    onContextMenu: handleContextMenu,
  };

  return handlers;
}
