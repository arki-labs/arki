/** `useIsTouchDevice`: true when the main pointer is coarse (a finger). */
import { useSyncExternalStore } from 'react';

const COARSE_POINTER = '(pointer: coarse)';

function subscribeToPointer(onChange: () => void) {
  const mediaQuery = window.matchMedia(COARSE_POINTER);
  mediaQuery.addEventListener('change', onChange);
  return () => mediaQuery.removeEventListener('change', onChange);
}

const readPointer = () => window.matchMedia(COARSE_POINTER).matches;
const readPointerOnServer = () => false;

export function useIsTouchDevice() {
  return useSyncExternalStore(subscribeToPointer, readPointer, readPointerOnServer);
}
