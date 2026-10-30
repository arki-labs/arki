'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';

import { isFailure } from '@arki/failure';
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

import type { AuthDefinition, SocialMethod } from '../definition.js';
import { SignInRefused } from '../boundary-failures.js';
import { authCapabilities } from './capabilities.js';

/**
 * Reusable, brand-neutral sign-in form shared across every Arki app.
 *
 * Email-first, magic-link-by-default. The password field is revealed *in
 * place* (no navigation) when the user opts into password sign-in, so a
 * typed email is preserved across the transition. Which controls render is
 * driven entirely by the app's auth `definition` (the same object the server
 * boots from), so no dead buttons ever appear.
 *
 * Security: there is intentionally no pre-submit "does this email have a
 * password?" lookup — that would leak account existence (email enumeration).
 * The form only branches *after* the user submits, and surfaces generic
 * errors.
 */

/** Async actions the form delegates to (wired per-app to the auth client). */
export type SignInHandlers = {
  /** Send a magic sign-in link to `email`. Resolves on send. */
  onMagicLink: (email: string) => Promise<void | SignInRefusal>;
  /**
   * Sign in with email + password. On success the handler is responsible for
   * navigating (it typically never resolves because the page redirects).
   */
  onPasswordSignIn: (email: string, password: string) => Promise<void | SignInRefusal>;
  /** Start an OAuth flow. The browser is redirected to the provider. */
  onSocialSignIn: (provider: SocialMethod) => Promise<void | SignInRefusal> | void;
};

/** A refused sign-in, returned by a handler. The form shows the text for its `data.reason`. */
export type SignInRefusal = ReturnType<typeof SignInRefused>;

export type SignInLocalization = {
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
  /** Shown when the email or password is wrong. */
  credentialsError: string;
  /** Shown when the account's email is not verified yet. */
  unverifiedError: string;
  /** Shown when too many attempts were made. */
  rateLimitedError: string;
};

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
  credentialsError: 'Check your details and try again.',
  unverifiedError: 'Verify your email address first. Check your inbox for the link.',
  rateLimitedError: 'Too many attempts. Wait a moment and try again.',
};

const SOCIAL_PROVIDERS: Record<SocialMethod, { label: string; Icon: Icon }> = {
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

/** What the form renders from: the app's auth definition (the same object the server boots from). */
export type SignInFormSource = { definition: AuthDefinition };

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
  definition,
}: SignInFormProps) {
  const l = { ...DEFAULT_LOCALIZATION, ...localization };

  const methods = authCapabilities(definition);
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
  const [socialPending, setSocialPending] = useState<SocialMethod | null>(null);
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

  /** The text for a refusal a handler returned: by its reason, never the server's own words. */
  function refusalMessage(refusal: SignInRefusal): string {
    const messages = {
      credentials: l.credentialsError,
      unverified: l.unverifiedError,
      rateLimited: l.rateLimitedError,
      unknown: l.genericError,
    } as const satisfies Record<SignInRefusal['data']['reason'], string>;
    return messages[refusal.data.reason];
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
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`#${passwordId}`)?.focus());
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
        const refused = await handlers.onPasswordSignIn(trimmedEmail, password);
        if (isFailure(refused)) {
          setError(refusalMessage(refused));
          setStatus('idle');
        }
        // On success the handler navigates away; keep the button busy.
        return;
      }
      const refused = await handlers.onMagicLink(trimmedEmail);
      if (isFailure(refused)) {
        setError(refusalMessage(refused));
        setStatus('idle');
        return;
      }
      setResent(false);
      setResendIn(RESEND_COOLDOWN_SECONDS);
      setStatus('sent');
    } catch (error_) {
      setError(resolveErrorMessage(error_));
      setStatus('idle');
    }
  }

  async function handleSocial(provider: SocialMethod) {
    if (busy) return;
    setError(null);
    try {
      setStatus('social');
      setSocialPending(provider);
      const refused = await handlers.onSocialSignIn(provider);
      if (isFailure(refused)) {
        setError(refusalMessage(refused));
        setStatus('idle');
        setSocialPending(null);
      }
    } catch (error_) {
      setError(resolveErrorMessage(error_));
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
      const refused = await handlers.onMagicLink(email.trim());
      if (isFailure(refused)) {
        setError(refusalMessage(refused));
        return;
      }
      setResent(true);
    } catch (error_) {
      setError(resolveErrorMessage(error_));
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

/**
 * Minimal shape of a better-auth call result the adapter inspects. `status` is the HTTP status
 * and `code` better-auth's error code (`EMAIL_NOT_VERIFIED`); the server's `message` is not read.
 */
type AuthClientResult = { error?: { status?: number | null; code?: string | null } | null };

/**
 * Structural subset of a better-auth client the adapter needs. Methods use
 * method syntax (not arrow properties) so parameter checking is bivariant —
 * an app's concrete client (with a narrower `provider` union and extra
 * optional args) stays assignable without `any` or unsafe casts.
 */
export type SignInCapableAuthClient = {
  signIn: {
    email(params: { email: string; password: string; callbackURL?: string }): Promise<AuthClientResult>;
    /** Absent when the definition does not enable magic links. */
    magicLink?(params: { email: string; callbackURL?: string }): Promise<AuthClientResult>;
    social(params: { provider: SocialMethod; callbackURL?: string }): Promise<AuthClientResult>;
  };
};

export type SignInHandlerOptions = {
  /** Where to send the user after a successful sign-in. */
  redirectTo: string;
  /**
   * Called after a successful password sign-in. Defaults to a full-document
   * navigation to `redirectTo` so the SSR session cookie is picked up.
   */
  onSignedIn?: () => void;
};

/** The reason a better-auth error means, from its HTTP status and code (the same map as the server's `failureOf`). */
function refusalReason(error: NonNullable<AuthClientResult['error']>): SignInRefusal['data']['reason'] {
  if (error.status === 429) return 'rateLimited';
  if (error.status === 401) return 'credentials';
  if (error.status === 403 && error.code === 'EMAIL_NOT_VERIFIED') return 'unverified';
  return 'unknown';
}

/** `undefined` when the call succeeded, else the refusal for its error. */
function refusalOf(result: AuthClientResult): SignInRefusal | undefined {
  return result.error ? SignInRefused({ reason: refusalReason(result.error) }) : undefined;
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
      return refusalOf(await authClient.signIn.magicLink({ email, callbackURL: redirectTo }));
    },
    onPasswordSignIn: async (email, password) => {
      const refused = refusalOf(await authClient.signIn.email({ email, password, callbackURL: redirectTo }));
      if (refused === undefined) signedIn();
      return refused;
    },
    onSocialSignIn: async provider => {
      return refusalOf(await authClient.signIn.social({ provider, callbackURL: redirectTo }));
    },
  };
}
