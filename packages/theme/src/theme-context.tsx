'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

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
  return window.matchMedia(MEDIA).matches ? 'dark' : 'light';
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
 * Apply theme to document
 */
function applyTheme(
  theme: ResolvedTheme,
  attribute: string,
  enableColorScheme: boolean,
  disableTransitionOnChange: boolean,
  themes: readonly string[],
): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

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

  // Apply theme attribute
  if (attribute === 'class') {
    root.classList.remove(...new Set([...themes.filter(value => value !== 'system'), 'light', 'dark']));
    root.classList.add(theme);
  } else {
    root.setAttribute(attribute, theme);
    root.classList.toggle('dark', theme === 'dark');
  }
  root.classList.toggle('is-dark', theme === 'dark');

  // Apply color-scheme
  if (enableColorScheme) {
    root.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
  }
}

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
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<string>(() => {
    // During SSR, use default theme
    if (typeof window === 'undefined') return normalizeTheme(defaultTheme, themes, defaultTheme);

    // On client, read from storage or use default
    const stored = getStoredTheme(storageKey);
    return normalizeTheme(stored, themes, defaultTheme);
  });

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());

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

    const mediaQuery = window.matchMedia(MEDIA);

    const handleChange = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light');
    };

    // Set initial value
    setSystemTheme(mediaQuery.matches ? 'dark' : 'light');

    // Listen for changes
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [enableSystem]);

  // Apply theme to document when it changes
  useEffect(() => {
    applyTheme(resolvedTheme, attribute, enableColorScheme, disableTransitionOnChange, themes);
  }, [resolvedTheme, attribute, enableColorScheme, disableTransitionOnChange, themes]);

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
