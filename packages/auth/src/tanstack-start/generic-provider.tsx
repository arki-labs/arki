'use client';

import type { AuthUIProviderProps } from '@daveyplate/better-auth-ui';
import type { ComponentType, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { AuthQueryProvider } from '@daveyplate/better-auth-tanstack';
import { AuthUIProviderTanstack } from '@daveyplate/better-auth-ui/tanstack';

/** The fallback for a navigation hook that has no router to call: it does nothing. */
const noop = (): void => {
  // Nothing to do without a router.
};

/**
 * Props for a framework-agnostic Link component
 */
export type LinkComponentProps = {
  href: string;
  children: ReactNode;
  className?: string;
  [key: string]: unknown;
};

/**
 * Props for a framework-agnostic Image component
 */
export type ImageComponentProps = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  [key: string]: unknown;
};

/**
 * Default Image component that wraps native img element.
 * Validates src before rendering to prevent errors with empty/null values.
 * Returns null to allow AvatarFallback to display instead.
 */
function DefaultImage({ src, alt, width, height, className, ...props }: ImageComponentProps) {
  // Don't render if src is empty/invalid
  if (!src || src === '') {
    return null;
  }
  return <img src={src} alt={alt} width={width} height={height} className={className} {...props} />;
}

/**
 * Default Link component that wraps native anchor element.
 * For proper SPA navigation, pass your router's Link component.
 */
function DefaultLink({ href, children, className, ...props }: LinkComponentProps) {
  return (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  );
}

/**
 * Hook that defers router access until after hydration.
 * Uses window.location for navigation - framework agnostic.
 */
function useDeferredRouter() {
  const [router, setRouter] = useState<{
    push: (url: string) => void;
    replace: (url: string) => void;
    refresh: () => void;
    back: () => void;
    forward: () => void;
    prefetch: () => void;
  } | null>(null);

  useEffect(() => {
    // Create a router-like object that uses window.location
    // This runs only on client after hydration
    setRouter({
      push: (url: string) => {
        window.location.href = url;
      },
      replace: (url: string) => {
        window.location.replace(url);
      },
      refresh: () => {
        window.location.reload();
      },
      back: () => {
        window.history.back();
      },
      forward: () => {
        window.history.forward();
      },
      prefetch: noop,
    });
  }, []);

  return router;
}

export type TanStackAuthProviderProps = {
  children: ReactNode;
  /**
   * Whether to disable authentication entirely.
   * When true, children are rendered without auth providers.
   */
  disabled?: boolean;
  /**
   * Link component for navigation (e.g., from @tanstack/react-router).
   * Defaults to native anchor element.
   */
  LinkComponent?: ComponentType<LinkComponentProps>;
  /**
   * Image component for avatars.
   * Defaults to native img element with validation.
   */
  ImageComponent?: ComponentType<ImageComponentProps>;
  /**
   * Custom navigate function. If not provided, uses window.location.href.
   */
  navigate?: (url: string) => void;
  /**
   * Custom replace function. If not provided, uses window.location.replace.
   */
  replace?: (url: string) => void;
  /**
   * Custom refresh function. If not provided, uses window.location.reload.
   */
  refresh?: () => void;
} & Omit<AuthUIProviderProps, 'Link' | 'avatar'>;

/**
 * TanStack Start-compatible auth provider for better-auth.
 *
 * This provider is framework-agnostic and works with TanStack Start, Vite, or any React app.
 * Pass your router's Link component and optionally a custom Image component for optimal integration.
 *
 * @example
 * ```tsx
 * import { Link } from '@tanstack/react-router';
 * import { TanStackAuthProvider } from '@arki/auth/tanstack-start';
 * import { authClient } from './auth/client';
 *
 * function Providers({ children }) {
 *   return (
 *     <TanStackAuthProvider
 *       authClient={authClient}
 *       LinkComponent={Link}
 *     >
 *       {children}
 *     </TanStackAuthProvider>
 *   );
 * }
 * ```
 */
export function TanStackAuthProvider({
  children,
  authClient,
  disabled = false,
  LinkComponent = DefaultLink,
  ImageComponent = DefaultImage,
  navigate: customNavigate,
  replace: customReplace,
  refresh: customRefresh,
  ...props
}: TanStackAuthProviderProps) {
  const router = useDeferredRouter();

  // If authentication is disabled, render children without auth provider
  if (disabled) {
    return <>{children}</>;
  }

  // Use custom functions or fall back to deferred router
  const navigate = customNavigate ?? router?.push ?? noop;
  const replace = customReplace ?? router?.replace ?? noop;
  const refresh = customRefresh ?? router?.refresh ?? noop;

  // Create a safe Image wrapper component
  const SafeImageComponent = ({ src, ...imageProps }: ImageComponentProps) => {
    if (!src || src === '') {
      return null;
    }
    return <ImageComponent src={src} {...imageProps} />;
  };

  return (
    <AuthQueryProvider>
      <AuthUIProviderTanstack
        authClient={authClient}
        navigate={navigate}
        persistClient={false}
        replace={replace}
        onSessionChange={() => {
          // Clear router cache (protected routes)
          refresh();
        }}
        Link={LinkComponent}
        avatar={{
          Image: SafeImageComponent,
        }}
        deleteUser={{
          verification: true,
        }}
        magicLink={true}
        optimistic={true}
        emailVerification={true}
        credentials={true}
        account={true}
        social={{
          providers: ['google', 'facebook'],
        }}
        {...props}
      >
        {children}
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  );
}
