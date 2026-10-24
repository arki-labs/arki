'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { ThemeDetectionOptions } from './script';
import { themeDetectionFn } from './script';

const MEDIA = '(prefers-color-scheme: dark)';
const STORAGE_KEY = 'theme';

export type Theme = 'light' | 'dark' | 'system' | (string & {});
export type ResolvedTheme = 'light' | 'dark' | (string & {});

export type ThemeProviderProps = {
  children: React.ReactNode;
  /** HTML attribute to apply theme (default: 'class') */
  attribute?: 'class' | 'data-theme' | `data-${string}`;
  /** Default theme if none is stored (default: 'system') */
  defaultTheme?: Theme;
  /** Enable color-scheme CSS property (default: true) */
  enableColorScheme?: boolean;
  /** Enable system theme detection (default: true) */
  enableSystem?: boolean;
  /** Storage key for theme persistence (default: 'theme') */
  storageKey?: string;
  /** List of available themes (default: ['light', 'dark', 'system']) */
  themes?: string[];
  /** Disable transitions during theme change */
  disableTransitionOnChange?: boolean;
  /** Force a specific theme (overrides user preference) */
  forcedTheme?: string;
  /** The classes each theme puts on the root element (default: a theme adds a class with its own name). */
  themeClasses?: ThemeDetectionOptions['themeClasses'];
  /** Nonce for CSP */
  nonce?: string;
};

export type UseThemeReturn = {
  /** Current theme setting */
  theme: string | undefined;
  /** Set the theme */
  setTheme: (theme: string) => void;
  /** Resolved theme (actual applied theme: 'light' or 'dark') */
  resolvedTheme: ResolvedTheme | undefined;
  /** System theme preference */
  systemTheme: ResolvedTheme | undefined;
  /** List of available themes */
  themes: string[];
  /** Forced theme if set */
  forcedTheme: string | undefined;
};

const ThemeContext = createContext<UseThemeReturn | undefined>(undefined);

const defaultThemes = ['light', 'dark', 'system'];

/**
 * Get the system theme preference
 */
function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  try {
    return window.matchMedia(MEDIA).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Get stored theme from localStorage
 */
function getStoredTheme(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Store theme in localStorage
 */
function storeTheme(key: string, theme: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, theme);
  } catch {
    // localStorage may not be available
  }
}

function normalizeTheme(theme: string | null, themes: readonly string[], defaultTheme: string): string {
  if (theme && themes.includes(theme)) return theme;
  if (themes.includes(defaultTheme)) return defaultTheme;
  return themes[0] ?? defaultTheme;
}

/**
 * Apply theme to document. The class and color-scheme rules live in `themeDetectionFn`,
 * the same function the pre-paint script runs, so the two cannot drift apart.
 */
function applyTheme(
  theme: ResolvedTheme,
  options: Omit<ThemeDetectionOptions, 'forcedTheme' | 'enableSystem' | 'storageKey' | 'defaultTheme'>,
  disableTransitionOnChange: boolean,
): void {
  if (typeof document === 'undefined') return;

  // Disable transitions during change if requested
  if (disableTransitionOnChange) {
    const css = document.createElement('style');
    css.append(
      document.createTextNode(
        '*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}',
      ),
    );
    document.head.append(css);

    // Force reflow
    (() => window.getComputedStyle(document.body))();

    // Remove after a tick
    setTimeout(() => {
      document.head.removeChild(css);
    }, 1);
  }

  themeDetectionFn({ ...options, forcedTheme: theme, enableSystem: false });
}

/** Hydration-only snapshot: nothing changes after mount, so there is nothing to subscribe to. */
const unsubscribeFromNothing = (): void => undefined;
function subscribeToNothing(): () => void {
  return unsubscribeFromNothing;
}
const isClient = () => true;
const isServer = () => false;

export function ThemeProvider({
  children,
  attribute = 'class',
  defaultTheme = 'system',
  enableColorScheme = true,
  enableSystem = true,
  storageKey = STORAGE_KEY,
  themes = defaultThemes,
  disableTransitionOnChange = false,
  forcedTheme,
  themeClasses,
}: ThemeProviderProps) {
  // False while React hydrates server HTML, true after. The server cannot read storage or
  // the OS preference, and React keeps mismatched attributes during hydration, so reading
  // them in the first client render would leave the server's default theme on screen.
  const hydrated = useSyncExternalStore(subscribeToNothing, isClient, isServer);
  // A theme chosen in this tab (setTheme) or another tab (storage event) wins over storage.
  const [chosenTheme, setThemeState] = useState<string | null>(null);
  const [watchedSystemTheme, setSystemTheme] = useState<ResolvedTheme | null>(null);
  const theme =
    chosenTheme ?? normalizeTheme(hydrated ? getStoredTheme(storageKey) : defaultTheme, themes, defaultTheme);
  const systemTheme = watchedSystemTheme ?? (hydrated ? getSystemTheme() : 'light');

  // Calculate resolved theme
  const resolvedTheme = useMemo<ResolvedTheme>(() => {
    if (forcedTheme) {
      return forcedTheme;
    }

    const themeToResolve = theme;

    if (themeToResolve === 'system' && enableSystem) {
      return systemTheme;
    }

    return themeToResolve;
  }, [theme, systemTheme, enableSystem, forcedTheme]);

  // Set theme function
  const setTheme = useCallback(
    (newTheme: string) => {
      const nextTheme = normalizeTheme(newTheme, themes, defaultTheme);
      setThemeState(nextTheme);
      storeTheme(storageKey, nextTheme);
    },
    [defaultTheme, storageKey, themes],
  );

  // Listen for system theme changes
  useEffect(() => {
    if (!enableSystem) return;

    try {
      const mediaQuery = window.matchMedia(MEDIA);
      const handleChange = (e: MediaQueryListEvent) => {
        setSystemTheme(e.matches ? 'dark' : 'light');
      };

      setSystemTheme(mediaQuery.matches ? 'dark' : 'light');
      mediaQuery.addEventListener('change', handleChange);
      return () => {
        try {
          mediaQuery.removeEventListener('change', handleChange);
        } catch {
          // Restricted browser APIs must not break provider cleanup.
        }
      };
    } catch {
      // Keep the detected preference when subscription is unavailable.
      return;
    }
  }, [enableSystem]);

  // Apply theme to document when it changes
  useEffect(() => {
    // While hydrating, the theme is still the server's default; the pre-paint script's
    // classes are the right ones, so leave them alone.
    if (!hydrated) return;
    applyTheme(resolvedTheme, { attribute, enableColorScheme, themes, themeClasses }, disableTransitionOnChange);
  }, [hydrated, resolvedTheme, attribute, enableColorScheme, disableTransitionOnChange, themes, themeClasses]);

  // Listen for storage changes (cross-tab sync)
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== storageKey || !e.newValue) return;
      setThemeState(normalizeTheme(e.newValue, themes, defaultTheme));
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [defaultTheme, storageKey, themes]);

  const value = useMemo<UseThemeReturn>(
    () => ({
      theme: forcedTheme ?? theme,
      setTheme,
      resolvedTheme,
      systemTheme,
      themes,
      forcedTheme,
    }),
    [theme, setTheme, resolvedTheme, systemTheme, themes, forcedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Default value returned during SSR or when ThemeProvider is not available.
 * This prevents errors during server-side rendering.
 */
const defaultContext: UseThemeReturn = {
  theme: undefined,
  setTheme: () => {},
  resolvedTheme: undefined,
  systemTheme: undefined,
  themes: defaultThemes,
  forcedTheme: undefined,
};

/**
 * Hook to access theme state and controls.
 * Returns default values during SSR to prevent hydration errors.
 */
export function useTheme(): UseThemeReturn {
  const context = useContext(ThemeContext);
  // Return default context during SSR or when provider is missing
  // This matches next-themes behavior and prevents SSR errors
  return context ?? defaultContext;
}
