'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';

import type { Icon } from '@arki/icons/phosphor';
import {
  AppleLogo,
  CheckCircle,
  CircleNotch,
  EnvelopeSimpleOpen,
  FacebookLogo,
  GithubLogo,
  GoogleLogo,
  WindowsLogo,
} from '@arki/icons/phosphor';
import { Button } from '@arki/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arki/ui/card';
import { cn } from '@arki/ui/cn';
import { Input } from '@arki/ui/input';
import { Label } from '@arki/ui/label';

import type { AuthDefinition } from '../definition.js';
import { authCapabilities } from './capabilities.js';

/**
 * Reusable, brand-neutral sign-in form shared across every Arki app.
 *
 * Email-first, magic-link-by-default. The password field is revealed *in
 * place* (no navigation) when the user opts into password sign-in, so a
 * typed email is preserved across the transition. Which controls render is
 * driven entirely by `config` (the deployment's live auth capabilities) so
 * no dead buttons ever appear.
 *
 * Security: there is intentionally no pre-submit "does this email have a
 * password?" lookup — that would leak account existence (email enumeration).
 * The form only branches *after* the user submits, and surfaces generic
 * errors.
 */

export type SocialProviderId = 'google' | 'apple' | 'microsoft' | 'facebook' | 'github';

/** Deployment auth capabilities — the source of truth for what renders. */
export interface AuthUiConfig {
  /** Social providers the live backend has credentials for. */
  socialProviders: SocialProviderId[];
  /** Email + password sign-in is enabled. */
  credentials: boolean;
  /** Passwordless magic-link sign-in is enabled. */
  magicLink: boolean;
  /** Verification emails are actually sent (informational; optional). */
  emailVerification?: boolean;
}

/** Async actions the form delegates to (wired per-app to the auth client). */
export interface SignInHandlers {
  /** Send a magic sign-in link to `email`. Resolves on send. */
  onMagicLink: (email: string) => Promise<void>;
  /**
   * Sign in with email + password. On success the handler is responsible for
   * navigating (it typically never resolves because the page redirects).
   */
  onPasswordSignIn: (email: string, password: string) => Promise<void>;
  /** Start an OAuth flow. The browser is redirected to the provider. */
  onSocialSignIn: (provider: SocialProviderId) => Promise<void> | void;
}

export interface SignInLocalization {
  title: string;
  /** Optional sub-title under the title. */
  description: string;
  email: string;
  emailPlaceholder: string;
  emailRequired: string;
  password: string;
  passwordPlaceholder: string;
  magicLinkAction: string;
  passwordAction: string;
  usePasswordToggle: string;
  useMagicLinkToggle: string;
  /** Prefix for social buttons, e.g. "Sign in with" + "Google". */
  signInWith: string;
  orContinueWith: string;
  forgotPassword: string;
  magicLinkSentTitle: string;
  /** `{email}` is replaced (and emphasised) with the address linked to. */
  magicLinkSentDescription: string;
  /** Lead-in before the resend countdown / link, e.g. "Didn't get it?". */
  magicLinkResendPrompt: string;
  /** `{seconds}` is replaced with the remaining cooldown, e.g. "Resend in {seconds}s". */
  magicLinkResendCountdown: string;
  /** Resend action shown once the cooldown elapses. */
  magicLinkResendAction: string;
  /** Confirmation after a successful resend. */
  magicLinkResentConfirmation: string;
  /** Lead-in before the change-email action, e.g. "Wrong email?". */
  changeEmailPrompt: string;
  /** Action that returns to the form to edit the email. */
  changeEmailAction: string;
  genericError: string;
}

const DEFAULT_LOCALIZATION: SignInLocalization = {
  title: 'Sign in',
  description: '',
  email: 'Email',
  emailPlaceholder: 'you@example.com',
  emailRequired: 'Enter your email address.',
  password: 'Password',
  passwordPlaceholder: '••••••••',
  magicLinkAction: 'Send sign-in link',
  passwordAction: 'Sign in',
  usePasswordToggle: 'Sign in with password',
  useMagicLinkToggle: 'Sign in with magic link',
  signInWith: 'Sign in with',
  orContinueWith: 'or continue with',
  forgotPassword: 'Forgot password?',
  magicLinkSentTitle: 'Check your inbox',
  magicLinkSentDescription: 'We sent a sign-in link to {email}.',
  magicLinkResendPrompt: "Didn't get it?",
  magicLinkResendCountdown: 'Resend in {seconds}s',
  magicLinkResendAction: 'Resend link',
  magicLinkResentConfirmation: 'Sent again — give it a minute to arrive.',
  changeEmailPrompt: 'Wrong email?',
  changeEmailAction: 'Change it',
  genericError: 'Something went wrong. Please try again.',
};

const SOCIAL_PROVIDERS: Record<SocialProviderId, { label: string; Icon: Icon }> = {
  google: { label: 'Google', Icon: GoogleLogo },
  apple: { label: 'Apple', Icon: AppleLogo },
  microsoft: { label: 'Microsoft', Icon: WindowsLogo },
  facebook: { label: 'Facebook', Icon: FacebookLogo },
  github: { label: 'GitHub', Icon: GithubLogo },
};

type Mode = 'magic-link' | 'password';
type Status = 'idle' | 'submitting' | 'social' | 'sent';

/** Cooldown before a magic link can be resent, mirroring the design prototype. */
const RESEND_COOLDOWN_SECONDS = 30;

/** Renders a "…{email}…" template with the address emphasised inline. */
function renderSentDescription(template: string, email: string): ReactNode {
  const parts = template.split('{email}');
  if (parts.length === 1) return template;
  return parts.map((part, index) => (
    <span key={index}>
      {part}
      {index < parts.length - 1 ? <strong className="font-medium text-foreground">{email}</strong> : null}
    </span>
  ));
}

/**
 * What the form renders from: the app's auth definition (the same object the server boots from).
 * `config` is the older hand-written form of the same facts.
 */
export type SignInFormSource =
  | { definition: AuthDefinition; config?: never }
  | {
      /** @deprecated Pass `definition` instead. */
      config: AuthUiConfig;
      definition?: never;
    };

/** The methods the form renders, read from either source. */
function formMethods(source: SignInFormSource): {
  social: readonly SocialProviderId[];
  password: boolean;
  magicLink: boolean;
} {
  if (source.definition !== undefined) return authCapabilities(source.definition);
  const { config } = source;
  return { social: config.socialProviders, password: config.credentials, magicLink: config.magicLink };
}

export type SignInFormProps = SignInFormSource & {
  handlers: SignInHandlers;
  localization?: Partial<SignInLocalization>;
  /** Which mode to open in. Clamped to an available mode. */
  initialMode?: Mode;
  /** Route for the "Forgot password?" link. Hidden when omitted. */
  forgotPasswordTo?: string;
  /** Replaces the default title/description header entirely. */
  header?: ReactNode;
  /** Rendered below the card body (e.g. a "Sign up" link). */
  footer?: ReactNode;
  className?: string;
};

function Spinner() {
  return <CircleNotch className="size-4 animate-spin" aria-hidden />;
}

export function SignInForm({
  handlers,
  localization,
  initialMode,
  forgotPasswordTo,
  header,
  footer,
  className,
  ...source
}: SignInFormProps) {
  const l = { ...DEFAULT_LOCALIZATION, ...localization };

  const methods = formMethods(source);
  const canMagicLink = methods.magicLink;
  const canPassword = methods.password;
  const bothModes = canMagicLink && canPassword;
  const defaultMode: Mode =
    (initialMode && (initialMode === 'password' ? canPassword : canMagicLink) ? initialMode : undefined) ??
    (canMagicLink ? 'magic-link' : 'password');

  const [mode, setMode] = useState<Mode>(defaultMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [socialPending, setSocialPending] = useState<SocialProviderId | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [resent, setResent] = useState(false);
  const sentHeadingRef = useRef<HTMLHeadingElement>(null);

  const passwordId = 'sign-in-password';
  const emailId = 'sign-in-email';
  const passwordOpen = mode === 'password' && canPassword;
  const busy = status === 'submitting' || status === 'social';
  const hasEmailAuth = canMagicLink || canPassword;

  function resolveErrorMessage(err: unknown): string {
    return err instanceof Error && err.message ? err.message : l.genericError;
  }

  // Tick the resend cooldown down while the "check your inbox" state is shown.
  useEffect(() => {
    if (status !== 'sent' || resent || resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn(seconds => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [status, resent, resendIn]);

  // Move focus to the confirmation heading so the state change is announced.
  useEffect(() => {
    if (status === 'sent') sentHeadingRef.current?.focus();
  }, [status]);

  function switchMode(next: Mode) {
    if (busy) return;
    setError(null);
    setMode(next);
    if (next === 'password') {
      requestAnimationFrame(() => document.getElementById(passwordId)?.focus());
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError(l.emailRequired);
      return;
    }

    try {
      setStatus('submitting');
      if (mode === 'password' && canPassword) {
        await handlers.onPasswordSignIn(trimmedEmail, password);
        // On success the handler navigates away; keep the button busy.
        return;
      }
      await handlers.onMagicLink(trimmedEmail);
      setResent(false);
      setResendIn(RESEND_COOLDOWN_SECONDS);
      setStatus('sent');
    } catch (err) {
      setError(resolveErrorMessage(err));
      setStatus('idle');
    }
  }

  async function handleSocial(provider: SocialProviderId) {
    if (busy) return;
    setError(null);
    try {
      setStatus('social');
      setSocialPending(provider);
      await handlers.onSocialSignIn(provider);
    } catch (err) {
      setError(resolveErrorMessage(err));
      setStatus('idle');
      setSocialPending(null);
    }
  }

  function resetToForm() {
    setStatus('idle');
    setError(null);
    setPassword('');
    setResent(false);
    setResendIn(0);
  }

  async function handleResend() {
    try {
      await handlers.onMagicLink(email.trim());
      setResent(true);
    } catch (err) {
      setError(resolveErrorMessage(err));
    }
  }

  const primaryLabel = mode === 'password' ? l.passwordAction : l.magicLinkAction;

  return (
    <Card className={cn('w-full', className)}>
      {status === 'sent' ? null : (
        <CardHeader>
          {header ?? (
            <>
              <CardTitle>{l.title}</CardTitle>
              {l.description ? <CardDescription>{l.description}</CardDescription> : null}
            </>
          )}
        </CardHeader>
      )}

      <CardContent className="flex flex-col gap-4">
        {status === 'sent' ? (
          <div className="flex flex-col items-center gap-4 py-4 text-center" role="status" data-slot="auth-sent">
            <span
              className="flex size-16 items-center justify-center text-foreground"
              data-slot="auth-sent-glyph"
              aria-hidden
            >
              <EnvelopeSimpleOpen className="size-11" />
            </span>
            <div className="space-y-2">
              <h2
                ref={sentHeadingRef}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none"
                data-slot="auth-sent-title"
              >
                {l.magicLinkSentTitle}
              </h2>
              <p className="mx-auto max-w-[38ch] text-sm text-muted-foreground" data-slot="auth-sent-body">
                {renderSentDescription(l.magicLinkSentDescription, email.trim())}
              </p>
            </div>
            <div
              className="flex flex-col items-center gap-2.5 text-sm text-muted-foreground"
              data-slot="auth-sent-meta"
            >
              {resent ? (
                <span className="inline-flex items-center gap-1.5" data-slot="auth-sent-resent">
                  <CheckCircle className="size-4 text-primary" weight="fill" aria-hidden />
                  {l.magicLinkResentConfirmation}
                </span>
              ) : resendIn > 0 ? (
                <span>
                  {l.magicLinkResendPrompt}{' '}
                  <span className="tabular-nums">
                    {l.magicLinkResendCountdown.replace('{seconds}', String(resendIn))}
                  </span>
                </span>
              ) : (
                <span>
                  {l.magicLinkResendPrompt}{' '}
                  <button
                    type="button"
                    className="font-medium underline underline-offset-2 transition-opacity hover:opacity-70"
                    data-slot="auth-sent-link"
                    onClick={handleResend}
                  >
                    {l.magicLinkResendAction}
                  </button>
                </span>
              )}
              <span>
                {l.changeEmailPrompt}{' '}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2 transition-opacity hover:opacity-70"
                  data-slot="auth-sent-link"
                  onClick={resetToForm}
                >
                  {l.changeEmailAction}
                </button>
              </span>
            </div>
          </div>
        ) : (
          <>
            {error ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}

            {hasEmailAuth ? (
              <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
                <div className="space-y-2">
                  <Label htmlFor={emailId}>{l.email}</Label>
                  <Input
                    id={emailId}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={l.emailPlaceholder}
                    value={email}
                    disabled={busy}
                    onChange={event => setEmail(event.target.value)}
                  />
                </div>

                {canPassword ? (
                  <div
                    className={cn(
                      'grid transition-all duration-300 ease-out motion-reduce:transition-none',
                      passwordOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                    )}
                  >
                    <div className="overflow-hidden">
                      <div className="space-y-2 pt-px">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor={passwordId}>{l.password}</Label>
                          {forgotPasswordTo ? (
                            <Link
                              to={forgotPasswordTo}
                              tabIndex={passwordOpen ? 0 : -1}
                              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                            >
                              {l.forgotPassword}
                            </Link>
                          ) : null}
                        </div>
                        <Input
                          id={passwordId}
                          type="password"
                          autoComplete="current-password"
                          placeholder={l.passwordPlaceholder}
                          value={password}
                          disabled={!passwordOpen || busy}
                          tabIndex={passwordOpen ? 0 : -1}
                          aria-hidden={!passwordOpen}
                          onChange={event => setPassword(event.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}

                <Button type="submit" className="w-full" size="lg" disabled={busy} aria-busy={status === 'submitting'}>
                  {status === 'submitting' ? <Spinner /> : primaryLabel}
                </Button>

                {bothModes ? (
                  <div className="text-center">
                    {mode === 'magic-link' ? (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        disabled={busy}
                        onClick={() => switchMode('password')}
                      >
                        {l.usePasswordToggle}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        disabled={busy}
                        onClick={() => switchMode('magic-link')}
                      >
                        {l.useMagicLinkToggle}
                      </Button>
                    )}
                  </div>
                ) : null}
              </form>
            ) : null}

            {methods.social.length > 0 ? (
              <>
                {hasEmailAuth ? (
                  <div className="flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground">{l.orContinueWith}</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                ) : null}

                <div className="flex flex-col gap-2">
                  {methods.social.map(provider => {
                    const meta = SOCIAL_PROVIDERS[provider];
                    const Icon = meta.Icon;
                    return (
                      <Button
                        key={provider}
                        type="button"
                        variant="outline"
                        size="lg"
                        className="w-full"
                        disabled={busy}
                        aria-busy={socialPending === provider}
                        onClick={() => handleSocial(provider)}
                      >
                        {socialPending === provider ? <Spinner /> : <Icon className="size-4" aria-hidden />}
                        {l.signInWith} {meta.label}
                      </Button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </>
        )}

        {footer ? <div className="text-center text-sm text-muted-foreground">{footer}</div> : null}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Auth-client adapter                                                        */
/* -------------------------------------------------------------------------- */

/** Minimal shape of a better-auth call result the adapter inspects. */
type AuthClientResult = { error?: { message?: string | null } | null };

/**
 * Structural subset of a better-auth client the adapter needs. Methods use
 * method syntax (not arrow properties) so parameter checking is bivariant —
 * an app's concrete client (with a narrower `provider` union and extra
 * optional args) stays assignable without `any` or unsafe casts.
 */
export interface SignInCapableAuthClient {
  signIn: {
    email(params: { email: string; password: string; callbackURL?: string }): Promise<AuthClientResult>;
    /** Absent when the definition does not enable magic links. */
    magicLink?(params: { email: string; callbackURL?: string }): Promise<AuthClientResult>;
    social(params: { provider: SocialProviderId; callbackURL?: string }): Promise<AuthClientResult>;
  };
}

export interface SignInHandlerOptions {
  /** Where to send the user after a successful sign-in. */
  redirectTo: string;
  /**
   * Called after a successful password sign-in. Defaults to a full-document
   * navigation to `redirectTo` so the SSR session cookie is picked up.
   */
  onSignedIn?: () => void;
}

function assertOk(result: AuthClientResult) {
  if (result.error) {
    throw new Error(result.error.message ?? 'Authentication failed.');
  }
}

/**
 * Wires a better-auth client to {@link SignInHandlers}. Pass the result as
 * the `handlers` prop of {@link SignInForm}.
 */
export function createSignInHandlers(
  authClient: SignInCapableAuthClient,
  { redirectTo, onSignedIn }: SignInHandlerOptions,
): SignInHandlers {
  const signedIn = onSignedIn ?? (() => window.location.assign(redirectTo));

  return {
    onMagicLink: async email => {
      if (authClient.signIn.magicLink === undefined) throw new Error('Magic-link sign-in is not enabled.');
      assertOk(await authClient.signIn.magicLink({ email, callbackURL: redirectTo }));
    },
    onPasswordSignIn: async (email, password) => {
      assertOk(await authClient.signIn.email({ email, password, callbackURL: redirectTo }));
      signedIn();
    },
    onSocialSignIn: async provider => {
      assertOk(await authClient.signIn.social({ provider, callbackURL: redirectTo }));
    },
  };
}
