/**
 * Inline script that applies the stored theme before first paint, so the page does not flash.
 *
 * Theme detection script for FOUC prevention.
 *
 * This script should be executed before React hydration to prevent
 * Flash of Unstyled Content (FOUC) when using dark mode.
 *
 * Usage in TanStack Start (__root.tsx):
 * ```tsx
 * import { ScriptOnce } from '@tanstack/react-router';
 * import { themeScript, THEME_STORAGE_KEY } from '@arki/ui/theme/script';
 *
 * // In your RootDocument component's <head>:
 * <ScriptOnce>{themeScript(THEME_STORAGE_KEY)}</ScriptOnce>
 * ```
 *
 * For Next.js, add a blocking inline script in the root layout's
 * html element (before body) using themeScript() to prevent FOUC.
 */

export const THEME_STORAGE_KEY = 'theme';

export type ThemeDetectionOptions = {
  storageKey?: string;
  attribute?: 'class' | 'data-theme' | `data-${string}`;
  defaultTheme?: string;
  themes?: readonly string[];
  enableSystem?: boolean;
  /**
   * The classes each theme puts on the root element, e.g. `{ 'candle-dark': ['dark', 'candlelight'] }`.
   * A theme not listed here adds a class with its own name, as before. A theme whose classes include
   * `dark` also gets `color-scheme: dark`. Every class named here is removed on each switch, so none goes stale.
   */
  themeClasses?: Readonly<Record<string, readonly string[]>>;
  /** Apply this already-resolved theme and skip storage and system detection (the provider uses this). */
  forcedTheme?: string;
  /** Set the `color-scheme` style on the root element (default: true). */
  enableColorScheme?: boolean;
};

/**
 * Generates an inline script string that detects and applies the theme
 * before React hydration, preventing FOUC.
 *
 * @param storageKey - The localStorage key used to store the theme preference
 * @param attribute - The attribute to apply to the HTML element ('class' or 'data-theme')
 * @returns A string containing the inline JavaScript to execute
 */
export function themeScript(
  storageKeyOrOptions: string | ThemeDetectionOptions = THEME_STORAGE_KEY,
  attribute: 'class' | 'data-theme' = 'class',
): string {
  const options =
    typeof storageKeyOrOptions === 'string' ? { storageKey: storageKeyOrOptions, attribute } : storageKeyOrOptions;

  return `(${themeDetectionFn.toString()})(${JSON.stringify(options)})`;
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
export function themeDetectionFn(input: string | ThemeDetectionOptions): void {
  try {
    const options = typeof input === 'string' ? { storageKey: input } : input;
    const storageKey = options.storageKey ?? 'theme';
    const attribute = options.attribute ?? 'class';
    const defaultTheme = options.defaultTheme ?? 'system';
    const themes = options.themes ?? ['light', 'dark', 'system'];
    const enableSystem = options.enableSystem ?? true;
    const themeClasses = options.themeClasses ?? {};
    const enableColorScheme = options.enableColorScheme ?? true;

    let selectedTheme: string;
    if (options.forcedTheme === undefined) {
      let theme: string | null = null;
      try {
        theme = localStorage.getItem(storageKey);
      } catch {
        // Storage restrictions must still allow the default theme to apply.
      }
      const storedTheme = theme !== null && themes.includes(theme) ? theme : defaultTheme;
      selectedTheme = themes.includes(storedTheme) ? storedTheme : (themes[0] ?? defaultTheme);
    } else {
      selectedTheme = options.forcedTheme;
    }
    let resolvedTheme = selectedTheme;
    if (selectedTheme === 'system' && enableSystem) {
      resolvedTheme = 'light';
      try {
        resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch {
        // Match the provider's light fallback when system detection is unavailable.
      }
    }

    const mapped = Object.prototype.hasOwnProperty.call(themeClasses, resolvedTheme)
      ? themeClasses[resolvedTheme]
      : undefined;
    const classesToAdd = mapped ?? (attribute === 'class' ? [resolvedTheme] : resolvedTheme === 'dark' ? ['dark'] : []);
    const isDark = classesToAdd.includes('dark');
    const root = document.documentElement;

    // Remove everything any theme can add, so switching never leaves a stale class behind.
    const everyClass = new Set(['light', 'dark', ...Object.values(themeClasses).flat()]);
    if (attribute === 'class') {
      for (const value of themes) if (value !== 'system') everyClass.add(value);
    }
    if (attribute !== 'class') {
      everyClass.delete('light');
      root.setAttribute(attribute, resolvedTheme);
    }
    root.classList.remove(...everyClass);
    root.classList.add(...classesToAdd);
    root.classList.toggle('is-dark', isDark);

    if (enableColorScheme) {
      root.style.colorScheme = isDark ? 'dark' : 'light';
    }
  } catch {
    // The host document may not be writable.
  }
}
