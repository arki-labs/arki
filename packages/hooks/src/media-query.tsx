import { useEffect, useState } from 'react';


const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1024;

/**
 * SSR-safe media query hook.
 * Returns defaultValue during SSR and initial hydration,
 * then updates to the actual value after the first effect runs.
 */
function useSafeMediaQuery(query: string, defaultValue = false): boolean {
  const [matches, setMatches] = useState(defaultValue);

  useEffect(() => {
    // Check if window is available (should always be true in useEffect)
    if (typeof window === 'undefined') return;

    const mql = window.matchMedia(query);

    // Set initial value immediately
    setMatches(mql.matches);

    // Listen for changes
    const handler = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

export function useIsMobile() {
  return useSafeMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`, false);
}

export function useIsTablet() {
  return useSafeMediaQuery(`(max-width: ${TABLET_BREAKPOINT - 1}px)`, false);
}

export function useIsDesktop() {
  return useSafeMediaQuery(`(min-width: ${TABLET_BREAKPOINT}px)`, false);
}

export function useIsTabletOrDesktop() {
  return useSafeMediaQuery(`(min-width: ${TABLET_BREAKPOINT}px)`, false);
}

export function useIsTouchDevice() {
  return useSafeMediaQuery(`(pointer: coarse)`, false);
}



export {useMediaQuery} from '@mantine/hooks';