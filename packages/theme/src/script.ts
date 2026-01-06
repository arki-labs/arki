/**
 * Theme detection script for FOUC prevention.
 *
 * This script should be executed before React hydration to prevent
 * Flash of Unstyled Content (FOUC) when using dark mode.
 *
 * Usage in TanStack Start (__root.tsx):
 * ```tsx
 * import { ScriptOnce } from '@tanstack/react-router';
 * import { themeScript, THEME_STORAGE_KEY } from '@arki/theme/script';
 *
 * // In your RootDocument component's <head>:
 * <ScriptOnce>{themeScript(THEME_STORAGE_KEY)}</ScriptOnce>
 * ```
 *
 * For Next.js, this is handled automatically by the ThemeProvider.
 */

export const THEME_STORAGE_KEY = 'theme';

/**
 * Generates an inline script string that detects and applies the theme
 * before React hydration, preventing FOUC.
 *
 * @param storageKey - The localStorage key used to store the theme preference
 * @param attribute - The attribute to apply to the HTML element ('class' or 'data-theme')
 * @returns A string containing the inline JavaScript to execute
 */
export function themeScript(
  storageKey: string = THEME_STORAGE_KEY,
  attribute: 'class' | 'data-theme' = 'class'
): string {
  // The script is minified and self-executing
  return `(function(){try{var t=localStorage.getItem("${storageKey}");var d=t==="dark"||((!t||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d){${
    attribute === 'class'
      ? 'document.documentElement.classList.add("dark")'
      : `document.documentElement.setAttribute("${attribute}","dark")`
  }}document.documentElement.style.colorScheme=d?"dark":"light"}catch(e){}})()`;
}

/**
 * A function that can be serialized and executed inline.
 * Use with TanStack Start's FunctionOnce pattern.
 *
 * @example
 * ```tsx
 * <FunctionOnce param={THEME_STORAGE_KEY}>
 *   {themeDetectionFn}
 * </FunctionOnce>
 * ```
 */
export function themeDetectionFn(storageKey: string): void {
  try {
    const theme = localStorage.getItem(storageKey);
    const isDark =
      theme === 'dark' ||
      ((theme === null || theme === 'system') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);

    if (isDark) {
      document.documentElement.classList.add('dark');
    }
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  } catch {
    // localStorage may not be available
  }
}
