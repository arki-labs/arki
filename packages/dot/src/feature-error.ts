/**
 * Error codes for feature composition. Shared by `feature()` (object form)
 * and `defineFeature()` (chain form), so both report through one class.
 */

export const FEATURE_ERROR_CODES = {
  duplicateRouterKey: 'FEATURE_E001',
  duplicateRepoKey: 'FEATURE_E002',
  duplicateSliceKey: 'FEATURE_E003',
  missingSlices: 'FEATURE_E004',
  missingCapability: 'FEATURE_E005',
  /** A need alias, infra key, provided key or entrypoint key collides with another slot or a reserved name. */
  keyCollision: 'FEATURE_E006',
  /** `override()` named a key that no infra plugin of the feature provides. */
  unknownOverride: 'FEATURE_E007',
  /** `routerFor()`: an app-contract key is implemented by zero or several features. */
  contractOwner: 'FEATURE_E008',
  /** `routerFor()`: a feature's contract is not mounted in the app contract. */
  contractNotMounted: 'FEATURE_E009',
  /** `rpc()`: a procedure's contract `meta` is not plain JSON, so `dot explain` cannot show it. */
  rpcMetaNotJson: 'FEATURE_E010',
} as const;

export type FeatureErrorCode = (typeof FEATURE_ERROR_CODES)[keyof typeof FEATURE_ERROR_CODES];

/**
 * A mistake in how features are composed. The types reject the same
 * mistake at compile time; this is the backstop for code that skips them.
 */
export class FeatureError extends Error {
  readonly code: FeatureErrorCode;
  readonly remediation: string;

  constructor(args: { readonly code: FeatureErrorCode; readonly message: string; readonly remediation: string }) {
    super(args.message);
    this.name = 'FeatureError';
    this.code = args.code;
    this.remediation = args.remediation;
  }
}
