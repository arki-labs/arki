/**
 * Package admission: every public package is either in exactly one wave
 * or listed in `ReleaseConfig.notYet` with a reason.
 *
 * Why: a public package that sits outside every wave is never published,
 * and nothing says so. The `admission` scorecard dimension turns that
 * silence into a failure.
 *
 * Status here uses local facts only. `published` needs an npm lookup, so
 * nothing in this file returns it.
 */

import type {
  NotYetEntry,
  PackageStatus,
  ReleaseConfig,
  ReleaseError,
  ReleaseWaveId,
  ScorecardDimensionResult,
} from './types';

/** Stable error codes for package admission. */
export const ADMISSION_ERROR_CODES = {
  /** A public package is in no wave and not in `notYet`. */
  unadmitted: 'ADMIT_E001',
  /** A package is in a wave and also in `notYet`. */
  conflict: 'ADMIT_E002',
  /** A `notYet` entry names a package the workspace does not have. */
  unknownNotYet: 'ADMIT_E003',
} as const;

/** Decide one package's status from its flag, wave, and `notYet` membership. */
export function resolvePackageStatus(input: {
  readonly private: boolean;
  readonly wave: ReleaseWaveId | null;
  readonly inNotYet: boolean;
}): PackageStatus {
  if (input.wave !== null && input.inNotYet) return 'conflict';
  if (input.private) return 'private';
  if (input.wave !== null) return 'candidate';
  if (input.inNotYet) return 'not-yet';
  return 'unadmitted';
}

/** The set of package names listed in `notYet`. */
export function notYetNames(config: ReleaseConfig): ReadonlySet<string> {
  return new Set((config.notYet ?? []).map((entry: NotYetEntry) => entry.name));
}

/** True when the status means the admission gate must fail. */
export function isAdmissionFailure(status: PackageStatus): boolean {
  return status === 'unadmitted' || status === 'conflict';
}

/** The `admission` scorecard dimension for one package. */
export function evaluateAdmission(packageName: string, status: PackageStatus): ScorecardDimensionResult {
  if (status === 'unadmitted') {
    const evidence: ReleaseError = {
      code: ADMISSION_ERROR_CODES.unadmitted,
      severity: 'error',
      message: `${packageName} is public but is in no wave and not in \`notYet\`.`,
      remediation: `Add it to a wave, add it to \`notYet\` with a reason in arki.release.config.ts, or set "private": true.`,
      target: packageName,
    };
    return { status: 'fail', details: 'public but in no wave and not in notYet', evidence: [evidence] };
  }
  if (status === 'conflict') {
    const evidence: ReleaseError = {
      code: ADMISSION_ERROR_CODES.conflict,
      severity: 'error',
      message: `${packageName} is in a wave and also in \`notYet\`.`,
      remediation: 'Remove it from `notYet` (it is admitted) or from the wave (it is not yet).',
      target: packageName,
    };
    return { status: 'fail', details: 'in a wave and in notYet', evidence: [evidence] };
  }
  return { status: 'pass', details: `admission status: ${status}`, evidence: [] };
}

/** Errors for `notYet` entries that name no workspace package. */
export function unknownNotYetErrors(config: ReleaseConfig, discovered: ReadonlySet<string>): ReleaseError[] {
  return (config.notYet ?? [])
    .filter(entry => !discovered.has(entry.name))
    .map(entry => ({
      code: ADMISSION_ERROR_CODES.unknownNotYet,
      severity: 'error',
      message: `\`notYet\` lists \`${entry.name}\` but no workspace manifest with that name was found.`,
      remediation: 'Fix the name or remove the entry from `notYet` in arki.release.config.ts.',
      target: entry.name,
    }));
}
