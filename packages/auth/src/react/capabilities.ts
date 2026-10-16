/**
 * What a definition turns on, as plain flags for UI: which buttons and modes to render. Read from
 * the same definition the server boots from, so the UI never shows a method the server refuses.
 */
import type { AuthDefinition, SocialMethodsOf } from '../definition.js';
import { isSocialMethod } from '../definition.js';

export type AuthCapabilities<D extends AuthDefinition = AuthDefinition> = {
  /** Every enabled method, as declared. */
  readonly methods: D['methods'];
  /** The enabled social providers, in declaration order. */
  readonly social: readonly SocialMethodsOf<D>[];
  readonly password: boolean;
  readonly magicLink: boolean;
  readonly workspaces: boolean;
};

/** Reads the capabilities of a definition. */
export function authCapabilities<D extends AuthDefinition>(definition: D): AuthCapabilities<D> {
  const methods: D['methods'] = definition.methods;
  return {
    methods,
    social: methods.filter((method): method is SocialMethodsOf<D> => isSocialMethod(method)),
    password: methods.includes('password'),
    magicLink: methods.includes('magicLink'),
    workspaces: definition.workspaces !== undefined,
  };
}
