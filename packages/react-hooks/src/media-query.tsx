import { useMediaQuery } from '@mantine/hooks';

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1024;

/**
 * SSR-safe media query hook.
 * Returns defaultValue during SSR and initial hydration,
 * then updates to the actual value after the first effect runs.
 *
 * Built on the re-exported @mantine/hooks `useMediaQuery` (which reads the query in an effect by
 * default), so this module imports nothing from React itself and a bundle that only takes
 * `useMediaQuery` carries no extra import.
 */
function useSafeMediaQuery(query: string, defaultValue = false): boolean {
  return useMediaQuery(query, defaultValue, { getInitialValueInEffect: true });
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

export { useMediaQuery } from '@mantine/hooks';
