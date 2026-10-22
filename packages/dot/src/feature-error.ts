/**
 * Error codes for feature composition: `defineFeature()` and the
 * services-bag helpers report through this one class.
 */

import { dotErrorDocsUrl } from './lifecycle.js';

export const FEATURE_ERROR_CODES = {
  /**
   * Two routers of a feature use the same key.
   * @fix Rename one of the two router keys.
   * @verify dot explain --json | jq -e .ok
   */
  duplicateRouterKey: 'ARKI_DOT_E022',
  /**
   * Two repos of a feature use the same key.
   * @fix Rename one of the two repo keys.
   * @verify dot explain --json | jq -e .ok
   */
  duplicateRepoKey: 'ARKI_DOT_E023',
  /**
   * Two slices of a feature use the same key.
   * @fix Rename one of the two slice keys.
   * @verify dot explain --json | jq -e .ok
   */
  duplicateSliceKey: 'ARKI_DOT_E024',
  /**
   * A feature was declared with no slices.
   * @fix Add at least one slice to the feature.
   * @verify dot explain --json | jq -e .ok
   */
  missingSlices: 'ARKI_DOT_E025',
  /**
   * A handle the feature needs is missing from the services bag.
   * @fix Mount the provider of that handle, and check the gateway's needs.
   * @verify dot doctor --json | jq -e .ok
   */
  missingCapability: 'ARKI_DOT_E026',
  /**
   * A need alias, infra key, provided key or entrypoint key collides with another slot or a reserved name.
   * @fix Rename the alias or key so it collides with nothing.
   * @verify dot explain --json | jq -e .ok
   */
  keyCollision: 'ARKI_DOT_E027',
  /**
   * `override()` named a key that no infra unit of the feature provides.
   * @fix Override a key that one of the feature's infra units provides.
   * @verify dot explain --json | jq -e .ok
   */
  unknownOverride: 'ARKI_DOT_E028',
  /**
   * `routerFor()`: an app-contract key is implemented by zero or several features.
   * @fix Give each app-contract key exactly one feature.
   * @verify dot explain --json | jq -e .ok
   */
  contractOwner: 'ARKI_DOT_E029',
  /**
   * `routerFor()`: a feature's contract is not mounted in the app contract.
   * @fix Mount the feature's contract in the app contract.
   * @verify dot explain --json | jq -e .ok
   */
  contractNotMounted: 'ARKI_DOT_E030',
  /**
   * `rpc()`: a procedure's contract `meta` is not plain JSON, so `dot explain` cannot show it.
   * @fix Keep the procedure's contract `meta` plain JSON.
   * @verify dot explain --json | jq -e .ok
   */
  rpcMetaNotJson: 'ARKI_DOT_E031',
  /**
   * A feature needs `domainService(fn)` that no parent declares above `.features()`: the parent never passed `fn` to `.domainServices()`, or the feature is top-level.
   * @fix Pass the factory to the parent's `.domainServices({ … })` before `.features()`, and need it only from that parent's children.
   * @verify dot explain --json | jq -e .ok
   */
  domainServiceNotAbove: 'ARKI_DOT_E034',
  /**
   * `.domainServices()` ran twice, or after `.features()`, `.usecases()` or `.provides()`.
   * @fix Declare every domain service in one `.domainServices({ … })` call, right after `.infra()`.
   * @verify dot explain --json | jq -e .ok
   */
  stepOrder: 'ARKI_DOT_E035',
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
