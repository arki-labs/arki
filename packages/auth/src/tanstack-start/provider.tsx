'use client';

import type { AuthUIProviderProps } from '@daveyplate/better-auth-ui';
import type { ReactNode } from 'react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { AuthQueryProvider } from '@daveyplate/better-auth-tanstack';
import { AuthUIProviderTanstack } from '@daveyplate/better-auth-ui/tanstack';

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

export function ArkiAuthProvider({
  children,
  authClient,
  disabled = false,
  ...props
}: AuthUIProviderProps & { children: ReactNode; disabled?: boolean }) {
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
        magicLink={true}
        optimistic={true}
        emailVerification={true}
        credentials={true}
        account={true}
        social={{
          providers: [
            'google',
            'facebook',
          ],
        }}
        {...props}
      >
        {children}
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  );
}
