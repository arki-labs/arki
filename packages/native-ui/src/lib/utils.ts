/**
 * Utility functions for React Native UI components
 */

export { truncate } from '@arki/string/format';
export { formatFileSize } from '@arki/math/format';

/**
 * Generates initials from a name string
 * @param name - Full name string
 * @returns Initials (max 2 characters)
 */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  const first = parts[0]!.charAt(0);
  const last = parts.at(-1)!.charAt(0);
  return (first + last).toUpperCase();
}

/** A debounced function: call it like the original, or `cancel()` the pending call (for example on unmount). */
export type Debounced<Args extends unknown[]> = ((...args: Args) => void) & { cancel: () => void };

/**
 * Debounces a function call
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced function with a `cancel()` for the pending call
 */
export function debounce<Args extends unknown[]>(fn: (...args: Args) => unknown, delay: number): Debounced<Args> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: Args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => {
    clearTimeout(timeoutId);
    timeoutId = undefined;
  };
  return debounced;
}
