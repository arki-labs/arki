/** `useViewport`: window size, a mobile / tablet / desktop type and touch capability. */
'use client';

import { useEffect, useState } from 'react';

export type ViewportType = 'mobile' | 'tablet' | 'desktop';

export type ViewportInfo = {
  type: ViewportType;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  width: number;
  height: number;
  // Touch capability detection
  isTouch: boolean;
}

const serverViewport: ViewportInfo = {
  type: 'desktop',
  isMobile: false,
  isTablet: false,
  isDesktop: true,
  width: 1024,
  height: 768,
  isTouch: false,
};

export function useViewport(): ViewportInfo {
  // The first render is the server's desktop default on both sides, so hydration matches. The effect reads the real window after mount.
  const [viewport, setViewport] = useState<ViewportInfo>(serverViewport);

  useEffect(() => {
    const updateViewport = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

      let type: ViewportType = 'desktop';
      if (width < 640) type = 'mobile';
      else if (width < 1024) type = 'tablet';

      setViewport({
        type,
        isMobile: type === 'mobile',
        isTablet: type === 'tablet',
        isDesktop: type === 'desktop',
        width,
        height,
        isTouch,
      });
    };

    updateViewport();

    // Use ResizeObserver for better performance if available
    if (typeof ResizeObserver === 'undefined') {
      // Fallback to window resize event
      window.addEventListener('resize', updateViewport, { passive: true });
      return () => window.removeEventListener('resize', updateViewport);
    } else {
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(updateViewport);
      });

      resizeObserver.observe(document.documentElement);

      return () => resizeObserver.disconnect();
    }
  }, []);

  return viewport;
}
