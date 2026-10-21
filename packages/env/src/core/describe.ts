/**
 * `describeEnv(env)`: the keys an env built by `defineEnv` declares, which of them are `secret()`,
 * and where they live. It reads the declaration only, never a value, so tools (`dot env check`) can
 * use it on a bare checkout.
 */
import type { StandardSchemaV1 } from '@arki/schema';

import { isSecretSchema } from './secret.js';

/** One declared key. */
export type EnvKeyDescription = {
  readonly key: string;
  /** Declared with `secret()`: must never be plaintext in a tracked file. */
  readonly secret: boolean;
  readonly scope: 'server' | 'client' | 'shared';
};

/** What an env declares, its `extends` included. */
export type EnvDescription = { readonly name?: string; readonly keys: readonly EnvKeyDescription[] };

const descriptions = new WeakMap<object, EnvDescription>();

/** The description of an env built by `defineEnv`, or `undefined` for any other object. */
export function describeEnv(env: object): EnvDescription | undefined {
  return descriptions.get(env);
}

/** Called by `defineEnv` once per env. Later scopes and the env's own keys win over `extends`. */
export function registerEnvDescription(
  env: object,
  declaration: {
    readonly name?: string;
    readonly server: Record<string, StandardSchemaV1>;
    readonly client?: Record<string, StandardSchemaV1>;
    readonly shared?: Record<string, StandardSchemaV1>;
    readonly extends?: readonly object[];
  },
): void {
  const keys = new Map<string, EnvKeyDescription>();
  for (const base of declaration.extends ?? []) {
    for (const key of describeEnv(base)?.keys ?? []) keys.set(key.key, key);
  }
  const scopes = [
    ['shared', declaration.shared],
    ['client', declaration.client],
    ['server', declaration.server],
  ] as const;
  for (const [scope, schemas] of scopes) {
    for (const [key, schema] of Object.entries(schemas ?? {})) keys.set(key, { key, secret: isSecretSchema(schema), scope });
  }
  descriptions.set(env, declaration.name === undefined ? { keys: [...keys.values()] } : { name: declaration.name, keys: [...keys.values()] });
}
