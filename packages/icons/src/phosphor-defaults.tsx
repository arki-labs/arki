'use client';

import { useContext } from 'react';
import { IconContext, type IconWeight } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/**
 * Shape of the values consumed by Phosphor's `<IconContext.Provider>`.
 * Mirrors `IconContextValue` from `@phosphor-icons/react` but kept local so
 * callers don't have to import from the underlying package.
 */
export type PhosphorDefaults = {
  color?: string;
  size?: number | string;
  weight?: IconWeight;
  mirrored?: boolean;
};

/**
 * Per-design-system Phosphor defaults.
 *
 * Each design system mounts a single provider near its app root. Picking
 * weight/size here propagates to every Phosphor icon underneath without
 * touching call sites — change one constant, the whole app shifts.
 *
 * Tune these to match the design system's character:
 *   - atelier  → editorial, warm, authored. Filled/duotone reads richer.
 *   - workbench → tool-first, calm utility. Regular reads quietest.
 *   - tribunal → editorial-evidence "case file". Regular line icons,
 *                inherited foreground — the chrome stays sober.
 */
export const ATELIER_PHOSPHOR_DEFAULTS = {
  weight: 'duotone',
  size: 20,
  color: 'currentColor',
} satisfies PhosphorDefaults;

export const WORKBENCH_PHOSPHOR_DEFAULTS = {
  weight: 'regular',
  size: 20,
  color: 'currentColor',
} satisfies PhosphorDefaults;

export const TRIBUNAL_PHOSPHOR_DEFAULTS = {
  weight: 'regular',
  size: 20,
  color: 'currentColor',
} satisfies PhosphorDefaults;

type ProviderProps = {
  children: ReactNode;
  /**
   * Override individual defaults for a subtree (e.g. switch a section to
   * `weight="bold"` without re-mounting the design-system root).
   */
  overrides?: PhosphorDefaults;
};

export function AtelierIconDefaults({ children, overrides }: ProviderProps) {
  return (
    <IconContext.Provider value={{ ...ATELIER_PHOSPHOR_DEFAULTS, ...overrides }}>
      {children}
    </IconContext.Provider>
  );
}

export function WorkbenchIconDefaults({ children, overrides }: ProviderProps) {
  return (
    <IconContext.Provider value={{ ...WORKBENCH_PHOSPHOR_DEFAULTS, ...overrides }}>
      {children}
    </IconContext.Provider>
  );
}

export function TribunalIconDefaults({ children, overrides }: ProviderProps) {
  return (
    <IconContext.Provider value={{ ...TRIBUNAL_PHOSPHOR_DEFAULTS, ...overrides }}>
      {children}
    </IconContext.Provider>
  );
}

/**
 * Generic provider for apps that don't use a shared design system.
 * Prefer the named providers above when you can.
 */
export function PhosphorIconDefaults({
  children,
  defaults,
}: {
  children: ReactNode;
  defaults: PhosphorDefaults;
}) {
  return <IconContext.Provider value={defaults}>{children}</IconContext.Provider>;
}

/**
 * Subtree-scoped overrides that *merge* with the inherited Phosphor context
 * instead of replacing it. Use this when one region of the UI should opt out
 * of a design-system default (e.g. logos and footer chrome staying on
 * `weight: 'regular'` even under `AtelierIconDefaults`).
 *
 * Unlike `IconContext.Provider`, which replaces the entire context value,
 * this wrapper preserves the parent's size/color/weight and only changes
 * the fields you pass in `overrides`.
 */
export function PhosphorIconScope({
  children,
  overrides,
}: {
  children: ReactNode;
  overrides: PhosphorDefaults;
}) {
  const inherited = useContext(IconContext);
  return (
    <IconContext.Provider value={{ ...inherited, ...overrides }}>{children}</IconContext.Provider>
  );
}
