/**
 * The browser auth client, built from the same definition as the server. It adds the engine's
 * client plugins the definition needs and nothing else, and carries `capabilities` for the UI.
 *
 * @example
 * export const authClient = createAuthClient(authDefinition, { baseURL: resolveAuthClientBaseUrl(env.VITE_URL) });
 * authClient.capabilities.social; // ['google'] when the definition enables Google
 */
import type { BetterAuthClientPlugin } from 'better-auth/client';
import { magicLinkClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient as createEngineClient } from 'better-auth/react';

import type { AuthDefinition, AuthMethod, WorkspacesOption } from '../definition.js';
import type { AuthCapabilities } from './capabilities.js';
import { resolveDefinition } from '../definition.js';
import { authCapabilities } from './capabilities.js';

type MagicLinkClientPlugin = ReturnType<typeof magicLinkClient>;

/** The client plugins each method needs. Typed per method, so the client's API follows `methods`. */
type MethodClientPlugins = {
  readonly password: readonly [];
  readonly magicLink: readonly [MagicLinkClientPlugin];
  readonly google: readonly [];
  readonly apple: readonly [];
  readonly facebook: readonly [];
  readonly microsoft: readonly [];
  readonly github: readonly [];
};

const METHOD_CLIENT_PLUGINS: { readonly [K in AuthMethod]: () => MethodClientPlugins[K] } = {
  password: () => [],
  magicLink: () => [magicLinkClient()],
  google: () => [],
  apple: () => [],
  facebook: () => [],
  microsoft: () => [],
  github: () => [],
};

const pluginsOfMethod = <K extends AuthMethod>(method: K): MethodClientPlugins[K] => METHOD_CLIENT_PLUGINS[method]();

/** The client plugins a definition's methods need. */
export type DefinitionClientPlugins<D extends AuthDefinition> = MethodClientPlugins[D['methods'][number]][number][];

/** The engine client plugins a definition's methods need, typed per method. */
export function definitionClientPlugins<D extends AuthDefinition>(definition: D): DefinitionClientPlugins<D> {
  return definition.methods.flatMap(method => pluginsOfMethod(method));
}

const workspaceFactories = {
  true: () => organizationClient({ teams: { enabled: true } }),
  false: () => organizationClient({ teams: { enabled: false } }),
};

/** The organization plugin per `teams` value. */
type WorkspacePlugins = {
  [K in keyof typeof workspaceFactories]: ReturnType<(typeof workspaceFactories)[K]>;
};

/**
 * The same factories, typed as a mapped type: indexing it with a generic key returns
 * `WorkspacePlugins[K]`, so the compiler checks the helper's return type against its body
 * (the "correlated union" pattern, TypeScript PR #47109).
 */
const WORKSPACES_CLIENT_PLUGINS: { [K in keyof WorkspacePlugins]: () => WorkspacePlugins[K] } = workspaceFactories;

/**
 * The client plugins a definition's `workspaces` value needs: the organization API (typed with or
 * without teams), or none. An indexed access, not a conditional type, so it stays generic until
 * the definition is known (a conditional type would be resolved early to "maybe teams").
 */
export type WorkspacesClientPlugins<W extends WorkspacesOption | undefined> =
  WorkspacePlugins[`${NonNullable<W>['teams']}`][];

/** Reads `value[key]` and keeps the indexed type `T[K]`; destructuring would widen it. */
function readProperty<T, K extends keyof T>(value: T, key: K): T[K] {
  return value[key];
}

/** The organization client plugin when `workspaces` is on, typed from the value as written. */
export function workspacesClientPlugins<D extends AuthDefinition>(
  definition: D,
): WorkspacesClientPlugins<D['workspaces']> {
  const workspaces = readProperty(definition, 'workspaces');
  if (workspaces === undefined) return [];
  const teams = readProperty(workspaces, 'teams');
  const key: `${NonNullable<D['workspaces']>['teams']}` = `${teams}`;
  return [WORKSPACES_CLIENT_PLUGINS[key]()];
}

export type AuthClientOptions<P extends readonly BetterAuthClientPlugin[]> = {
  /** Absolute URL of the app. In the browser use `resolveAuthClientBaseUrl` so SSR and client agree. */
  readonly baseURL?: string;
  /** Replaces the global `fetch` (tests, custom transports). */
  readonly fetch?: typeof fetch;
  /** Extra engine client plugins. The definition's own (magic link, organizations) are added already. */
  readonly plugins?: P;
};

/**
 * Builds the auth client for a definition. A definition with `workspaces` gets the organization
 * API (`organizationClient()`), typed with or without teams as the definition says.
 */
export function createAuthClient<
  const D extends AuthDefinition,
  const P extends readonly BetterAuthClientPlugin[] = readonly [],
>(definition: D, options: AuthClientOptions<P> = {}) {
  resolveDefinition(definition);
  const extra = options.plugins ?? [];
  const engineClient = createEngineClient({
    ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
    ...(options.fetch !== undefined && { fetchOptions: { customFetchImpl: options.fetch } }),
    plugins: [...definitionClientPlugins(definition), ...workspacesClientPlugins(definition), ...extra],
  });
  return withCapabilities(engineClient, authCapabilities(definition));
}

/**
 * Adds `capabilities` to the engine client. The engine client is a Proxy that answers every key it
 * does not know with a route proxy, so a property set on it cannot be read back; the outer Proxy
 * answers `capabilities` itself and hands every other key to the engine client.
 */
function withCapabilities<C extends object, D extends AuthDefinition>(client: C, capabilities: AuthCapabilities<D>) {
  return new Proxy(Object.assign(client, { capabilities }), {
    get: (target, property, receiver): unknown =>
      property === 'capabilities' ? capabilities : Reflect.get(target, property, receiver),
  });
}

/** The client `createAuthClient` returns for a definition. */
export type AuthClient<
  D extends AuthDefinition,
  P extends readonly BetterAuthClientPlugin[] = readonly [],
> = ReturnType<typeof createAuthClient<D, P>>;
