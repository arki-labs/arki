/**
 * Auth events as plain functions. Sign-in, failure, sign-out and password change are read from
 * the engine's HTTP answers (status, path, the session cookie it sets), so they do not depend on
 * engine internals. User creation and password reset come from the engine's own callbacks.
 *
 * Observers never change the response: a throwing observer is logged and the answer stays.
 */
import { isFailure } from '@arki/failure';

import { is, recordSchema } from '@arki/schema';
import type { AuthMethod } from '../definition.js';
import type { AuthEvents, SignInFailure } from './types.js';
import { isSocialMethod } from '../definition.js';
import { authRequestId } from '../id-declarations.js';
import { errorField, log } from '../log.js';
import { observeAuth, observeSafely } from './telemetry.js';

/** Where the engine's routes are mounted. */
export const AUTH_BASE_PATH = '/api/auth';

/** The engine route below the base path: `/sign-in/email`, `/callback/google`, … */
export function enginePath(request: Request): string {
  const { pathname } = new URL(request.url);
  return pathname.startsWith(AUTH_BASE_PATH) ? pathname.slice(AUTH_BASE_PATH.length) : pathname;
}

/** The method a route signs in with, when it is a sign-in (or sign-up) route. */
export function signInMethodOf(path: string, methods: readonly AuthMethod[]): AuthMethod | undefined {
  const method = signInMethodOfPath(path);
  return method !== undefined && methods.includes(method) ? method : undefined;
}

function signInMethodOfPath(path: string): AuthMethod | undefined {
  if (path === '/sign-in/email' || path === '/sign-up/email') return 'password';
  if (path === '/magic-link/verify') return 'magicLink';
  const provider = /^\/callback\/([^/]+)$/.exec(path)?.[1];
  return provider !== undefined && isSocialMethod(provider) ? provider : undefined;
}

/**
 * The method of an id-token sign-in: `/sign-in/social` with an `idToken` in the body. It signs in
 * (and may create the user) in place, with the provider named in the body, not the path.
 */
export function idTokenMethodOf(path: string, body: unknown, methods: readonly AuthMethod[]): AuthMethod | undefined {
  if (path !== '/sign-in/social' || typeof body !== 'object' || body === null) return undefined;
  if (Reflect.get(body, 'idToken') === undefined) return undefined;
  const provider: unknown = Reflect.get(body, 'provider');
  return typeof provider === 'string' && isSocialMethod(provider) && methods.includes(provider) ? provider : undefined;
}

/** The method behind a user creation, from the engine's provisioning source. */
export function methodOfSource(source: { readonly method: string; readonly oauth?: { readonly providerId: string } }) {
  if (source.method === 'email-password') return 'password';
  if (source.method === 'magic-link') return 'magicLink';
  const provider = source.oauth?.providerId;
  return source.method === 'oauth' && provider !== undefined && isSocialMethod(provider) ? provider : undefined;
}

/** Why a sign-in answer failed. */
export async function failureOf(response: Response): Promise<SignInFailure | undefined> {
  if (response.status === 429) return 'rateLimited';
  if (response.status === 401) return 'credentials';
  if (response.status === 403) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const code: unknown = is(body, recordSchema) ? Reflect.get(body, 'code') : undefined;
    return code === 'EMAIL_NOT_VERIFIED' ? 'unverified' : 'unknown';
  }
  if (response.status >= 400) return 'unknown';
  // Link and OAuth routes answer failures with a redirect that carries `error=`.
  const location = response.headers.get('location');
  if (location !== null && /[?&]error=/.test(location)) return 'credentials';
  return undefined;
}

/** Generation failure suppresses only observation, never a completed business response. */
export function requestIdOf(headers: Headers) {
  const inbound = headers.get('x-request-id');
  const requestId = inbound === null ? authRequestId.create() : authRequestId.schema.parse(inbound);
  if (isFailure(requestId)) {
    observeSafely(() => log.warn('Auth event correlation unavailable; the operation result is unchanged', { failure: requestId }));
  }
  return requestId;
}

type Events<P, U> = Required<AuthEvents<P, U>>;
type EventOf<P, U, K extends keyof Events<P, U>> = Parameters<Events<P, U>[K]>[0];

/** Calls one observer, logs its failure, never throws. */
export async function runObserver(name: string, call: () => void | Promise<void> | undefined): Promise<void> {
  try {
    await observeAuth(`auth.observer.${name}`, call);
  } catch (error) {
    observeSafely(() => log.warn('The {name} observer threw; the response is unchanged', { name, error: errorField(error) }));
  }
}

/** One emitter per event. */
export function createEmitter<P, U>(on: AuthEvents<P, U> | undefined) {
  return {
    userCreated: (event: EventOf<P, U, 'userCreated'>) => runObserver('userCreated', () => on?.userCreated?.(event)),
    signIn: (event: EventOf<P, U, 'signIn'>) => runObserver('signIn', () => on?.signIn?.(event)),
    signInFailed: (event: EventOf<P, U, 'signInFailed'>) =>
      runObserver('signInFailed', () => on?.signInFailed?.(event)),
    passwordChanged: (event: EventOf<P, U, 'passwordChanged'>) =>
      runObserver('passwordChanged', () => on?.passwordChanged?.(event)),
    signOut: (event: EventOf<P, U, 'signOut'>) => runObserver('signOut', () => on?.signOut?.(event)),
  };
}
