/**
 * Error codes for feature composition. Shared by `feature()` (object form)
 * and `defineFeature()` (chain form), so both report through one class.
 */

import { dotErrorDocsUrl } from './lifecycle.js';

export const FEATURE_ERROR_CODES = {
  duplicateRouterKey: 'ARKI_DOT_E022',
  duplicateRepoKey: 'ARKI_DOT_E023',
  duplicateSliceKey: 'ARKI_DOT_E024',
  missingSlices: 'ARKI_DOT_E025',
  missingCapability: 'ARKI_DOT_E026',
  /** A need alias, infra key, provided key or entrypoint key collides with another slot or a reserved name. */
  keyCollision: 'ARKI_DOT_E027',
  /** `override()` named a key that no infra plugin of the feature provides. */
  unknownOverride: 'ARKI_DOT_E028',
  /** `routerFor()`: an app-contract key is implemented by zero or several features. */
  contractOwner: 'ARKI_DOT_E029',
  /** `routerFor()`: a feature's contract is not mounted in the app contract. */
  contractNotMounted: 'ARKI_DOT_E030',
  /** `rpc()`: a procedure's contract `meta` is not plain JSON, so `dot explain` cannot show it. */
  rpcMetaNotJson: 'ARKI_DOT_E031',
} as const;

export type FeatureErrorCode = (typeof FEATURE_ERROR_CODES)[keyof typeof FEATURE_ERROR_CODES];

/**
 * A mistake in how features are composed. The types reject the same
 * mistake at compile time; this is the backstop for code that skips them.
 */
export class FeatureError extends Error {
  readonly code: FeatureErrorCode;
  readonly remediation: string;
  readonly docsUrl: string;

  constructor(args: { readonly code: FeatureErrorCode; readonly message: string; readonly remediation: string }) {
    super(args.message);
    this.name = 'FeatureError';
    this.code = args.code;
    this.remediation = args.remediation;
    this.docsUrl = dotErrorDocsUrl(args.code);
  }
}
