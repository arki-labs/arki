'use client';

import * as React from 'react';

/**
 * Backwards-compat shim for the Radix-style `asChild` pattern.
 *
 * Radix:
 * ```tsx
 * <Trigger asChild>
 *   <Button>Click me</Button>
 * </Trigger>
 * ```
 *
 * Base UI equivalent:
 * ```tsx
 * <Trigger render={<Button />}>Click me</Trigger>
 * ```
 *
 * `withAsChild` translates the former into the latter so consumer code can
 * keep the Radix shape during migration. If `asChild` is false or the children
 * isn't a single React element, falls back to plain children.
 *
 * Usage inside a Base UI primitive wrapper:
 * ```tsx
 * function CollapsibleTrigger({ asChild, children, ...props }: Props & AsChildProp) {
 *   const compat = withAsChild({ asChild, children });
 *   return <CollapsiblePrimitive.Trigger {...props} {...compat} />;
 * }
 * ```
 */
export type AsChildProp = {
  /**
   * When true and `children` is a single ReactElement, renders the trigger as
   * that element (Base UI `render` prop) rather than wrapping in a default
   * button. Mimics Radix's `asChild` API.
   */
  asChild?: boolean;
};

type CompatProps = {
  render?: React.ReactElement;
  children?: React.ReactNode;
};

export function withAsChild({
  asChild,
  children,
}: {
  asChild?: boolean;
  children?: React.ReactNode;
}): CompatProps {
  if (!asChild || !React.isValidElement(children)) {
    return { children };
  }
  const child = children as React.ReactElement<{ children?: React.ReactNode }>;
  return {
    render: child,
    children: child.props.children,
  };
}
