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

    const theme = localStorage.getItem(storageKey);
    const storedTheme = theme !== null && themes.includes(theme) ? theme : defaultTheme;
    const selectedTheme = themes.includes(storedTheme) ? storedTheme : (themes[0] ?? defaultTheme);
    const resolvedTheme =
      selectedTheme === 'system' && enableSystem
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : selectedTheme;
    const isDark = resolvedTheme === 'dark';

    if (attribute === 'class') {
      document.documentElement.classList.remove(
        ...new Set([...themes.filter(value => value !== 'system'), 'light', 'dark']),
      );
      document.documentElement.classList.add(resolvedTheme);
    } else {
      document.documentElement.setAttribute(attribute, resolvedTheme);
      document.documentElement.classList.toggle('dark', isDark);
    }
    document.documentElement.classList.toggle('is-dark', isDark);

    if (isDark && attribute !== 'class') {
      document.documentElement.classList.add('dark');
    }
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  } catch {
    // localStorage may not be available
  }
}
