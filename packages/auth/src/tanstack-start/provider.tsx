'use client';

import type { AuthUIProviderProps } from '@daveyplate/better-auth-ui';
import type { ReactNode } from 'react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { AuthQueryProvider } from '@daveyplate/better-auth-tanstack';
import { AuthUIProviderTanstack } from '@daveyplate/better-auth-ui/tanstack';

import type { AuthCapabilities } from '../react/capabilities.js';

/**
 * Safe image wrapper that validates src before rendering.
 * Returns null to allow AvatarFallback to display instead of a broken image.
 */
function SafeImage({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  if (!src || src === '') {
    return null;
  }
  return <img src={src} alt={alt ?? ''} {...props} />;
}

/** The UI flags that follow the definition: which sign-in methods the auth screens offer. */
function methodProps(capabilities: AuthCapabilities): Pick<AuthUIProviderProps, 'credentials' | 'magicLink' | 'social'> {
  return {
    credentials: capabilities.password,
    magicLink: capabilities.magicLink,
    social: capabilities.social.length > 0 ? { providers: [...capabilities.social] } : undefined,
  };
}

/**
 * `capabilities` (from `createAuthClient(definition).capabilities`) decides which sign-in methods
 * the auth screens offer. Without it the provider keeps its older fixed set (password, magic link,
 * Google and Facebook).
 */
export function ArkiAuthProvider({
  children,
  authClient,
  capabilities,
  disabled = false,
  ...props
}: AuthUIProviderProps & { children: ReactNode; disabled?: boolean; capabilities?: AuthCapabilities }) {
  const tsNavigate = useNavigate();
  const router = useRouter();

  if (disabled) {
    return <>{children}</>;
  }

  const navigate = (url: string) => void tsNavigate({ to: url });
  const replace = (url: string) => void tsNavigate({ to: url, replace: true });
  const refresh = () => router.invalidate();

  return (
    <AuthQueryProvider>
      <AuthUIProviderTanstack
        authClient={authClient}
        navigate={navigate}
        persistClient={false}
        replace={replace}
        onSessionChange={() => {
          refresh();
        }}
        Link={Link as AuthUIProviderProps['Link']}
        avatar={{
          Image: SafeImage as NonNullable<Exclude<AuthUIProviderProps['avatar'], boolean>>['Image'],
        }}
        deleteUser={{
          verification: true,
        }}
        optimistic={true}
        emailVerification={true}
        account={true}
        {...(capabilities === undefined
          ? { magicLink: true, credentials: true, social: { providers: ['google', 'facebook'] } }
          : methodProps(capabilities))}
        {...props}
      >
        {children}
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  );
}
