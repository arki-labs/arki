import * as React from 'react';

import { cn } from './cn';

function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> {
  return (value) => {
    refs.forEach((ref) => {
      if (typeof ref === 'function') ref(value);
      else if (ref != null) (ref as React.MutableRefObject<T | null>).current = value;
    });
  };
}

type SlotProps = {
  children?: React.ReactNode;
  ref?: React.Ref<HTMLElement>;
  className?: string;
  [key: string]: unknown;
};

/**
 * Merges the slot's props into its single child element.
 * Replacement for Radix UI's `Slot` / `asChild` pattern.
 *
 * - `className` values are concatenated via `cn()`
 * - Event handlers (`on*`) are composed so both parent and child handlers run
 * - Refs are merged with `mergeRefs`
 * - All other slot props override child props
 */
export function Slot({ children, ref: slotRef, className: slotClassName, ...slotProps }: SlotProps) {
  if (!React.isValidElement(children)) return <>{children}</>;

  const child = children as React.ReactElement<Record<string, unknown>>;
  const childProps = child.props as Record<string, unknown>;
  const childRef = (children as { ref?: React.Ref<HTMLElement> }).ref;

  const merged: Record<string, unknown> = { ...childProps };

  for (const key of Object.keys(slotProps)) {
    const slotVal = slotProps[key];
    const childVal = childProps[key];

    if (key.startsWith('on') && typeof slotVal === 'function' && typeof childVal === 'function') {
      merged[key] = (...args: unknown[]) => {
        (slotVal as (...a: unknown[]) => void)(...args);
        (childVal as (...a: unknown[]) => void)(...args);
      };
    } else {
      // Slot props take precedence; fall back to child value if slot prop is undefined
      merged[key] = slotVal !== undefined ? slotVal : childVal;
    }
  }

  const childClassName = childProps.className as string | undefined;
  if (slotClassName || childClassName) {
    merged.className = cn(slotClassName, childClassName) || undefined;
  }

  if (slotRef || childRef) {
    merged.ref = mergeRefs(slotRef, childRef);
  }

  return React.cloneElement(child, merged);
}
