import type { AnchorHTMLAttributes, ComponentType } from 'react';

/**
 * A framework-agnostic link component type compatible with Next.js Link,
 * TanStack Router Link, and any other router that renders an anchor element.
 *
 * Accepts standard anchor HTML attributes with a required `href` string.
 * Use this instead of `IntlLink` from `@arki/intl/next-navigation` when the
 * consuming component must work across multiple frameworks.
 */
export type LinkComponent = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;
