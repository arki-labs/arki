'use client';

import type { AuthUIProviderProps } from '@daveyplate/better-auth-ui';
import type { ReactNode } from 'react';
import { useContext } from 'react';
import { AuthQueryProvider } from '@daveyplate/better-auth-tanstack';
import { AuthUIContext } from '@daveyplate/better-auth-ui';
import { AuthUIProviderTanstack } from '@daveyplate/better-auth-ui/tanstack';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';

import type { AuthCapabilities } from '../react/capabilities.js';
import type { UserChangeHandler } from './user-change.js';
import { useUserChange } from './user-change.js';

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
function methodProps(
  capabilities: AuthCapabilities,
): Pick<AuthUIProviderProps, 'credentials' | 'magicLink' | 'social'> {
  return {
    credentials: capabilities.password,
    magicLink: capabilities.magicLink,
    social: capabilities.social.length > 0 ? { providers: [...capabilities.social] } : undefined,
  };
}

/** Reports the session's user to `onUserChange`, using the same session query as the auth screens. */
function UserChangeReporter({ onUserChange }: { onUserChange: UserChangeHandler }) {
  const session = useContext(AuthUIContext).hooks.useSession();
  const known = !session.isPending && !session.error;
  useUserChange(known ? (session.data?.user.id ?? null) : undefined, onUserChange);
  return null;
}

/**
 * `capabilities` (from `createAuthClient(definition).capabilities`) decides which sign-in methods
 * the auth screens offer, so they never show a method the server refuses.
 *
 * `onUserChange` gets the signed-in user's id, or `null` when signed out, each time that
 * changes: on sign-in, sign-out, and a new session that replaced another user's. It is never
 * called while the session is still loading or failed to load, and not twice in a row for the
 * same user while the provider stays mounted. Use it for per-user cleanup, such as dropping
 * the previous user's offline caches. With `disabled` there is no session and it is never called.
 */
export function ArkiAuthProvider({
  children,
  authClient,
  capabilities,
  disabled = false,
  onUserChange,
  ...props
}: AuthUIProviderProps & {
  children: ReactNode;
  disabled?: boolean;
  capabilities: AuthCapabilities;
  onUserChange?: UserChangeHandler;
}) {
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
          void refresh();
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
        {...methodProps(capabilities)}
        {...props}
      >
        {onUserChange && <UserChangeReporter onUserChange={onUserChange} />}
        {children}
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  );
}
