/**
 * Why these tests exist: a public package that sits outside every wave is
 * never published, and nobody notices. Admission turns that into a loud
 * failure, so the tests pin each way a package can end up unlisted.
 */

import { describe, expect, it } from 'vitest';

import {
  ADMISSION_ERROR_CODES,
  evaluateAdmission,
  notYetNames,
  resolvePackageStatus,
  unknownNotYetErrors,
} from './admission';
import { validateConfig } from './config';
import { classifyManifests } from './inventory';
import type { ReleaseConfig } from './types';

const baseConfig: ReleaseConfig = {
  publicTreePath: '.release/arki-public',
  publicMetadataDefaults: {
    license: 'MIT',
    repository: { type: 'git', url: 'https://example.com/repo.git' },
    bugs: { url: 'https://example.com/issues' },
    homepage: 'https://example.com',
    publishConfig: { access: 'public' },
    keywords: ['arki'],
  },
  waves: [{ id: 'foundation', label: 'Wave 1', packages: ['@arki/assert'] }],
  notYet: [{ name: '@arki/lock', reason: 'docs batch pending' }],
};

const manifests = [
  { manifestPath: 'packages/assert/package.json', name: '@arki/assert', version: '1.0.0', private: false },
  { manifestPath: 'packages/lock/package.json', name: '@arki/lock', version: '0.0.1', private: false },
  { manifestPath: 'packages/queue/package.json', name: '@arki/queue', version: '0.0.1', private: true },
];

function statusOf(config: ReleaseConfig, name: string): string | undefined {
  const env = classifyManifests({ manifests, diagnostics: [], config });
  return env.items.find(item => item.name === name)?.status;
}

describe('resolvePackageStatus', () => {
  it('maps each local situation to one status', () => {
    expect(resolvePackageStatus({ private: true, wave: null, inNotYet: false })).toBe('private');
    expect(resolvePackageStatus({ private: false, wave: null, inNotYet: true })).toBe('not-yet');
    expect(resolvePackageStatus({ private: false, wave: 'foundation', inNotYet: false })).toBe('candidate');
    expect(resolvePackageStatus({ private: false, wave: null, inNotYet: false })).toBe('unadmitted');
    expect(resolvePackageStatus({ private: false, wave: 'foundation', inNotYet: true })).toBe('conflict');
  });
});

describe('evaluateAdmission', () => {
  it('fails a public package outside every wave with ADMIT_E001', () => {
    const result = evaluateAdmission('@arki/lock', 'unadmitted');
    expect(result.status).toBe('fail');
    expect(result.evidence[0]?.code).toBe(ADMISSION_ERROR_CODES.unadmitted);
    expect(ADMISSION_ERROR_CODES.unadmitted).toBe('ADMIT_E001');
  });

  it('fails a package listed in both a wave and notYet with ADMIT_E002', () => {
    const result = evaluateAdmission('@arki/lock', 'conflict');
    expect(result.status).toBe('fail');
    expect(result.evidence[0]?.code).toBe('ADMIT_E002');
  });

  it.each(['private', 'not-yet', 'candidate', 'published'] as const)('passes %s', status => {
    expect(evaluateAdmission('@arki/x', status).status).toBe('pass');
  });
});

describe('admission through the inventory', () => {
  it('lists lock as not-yet while it is in notYet', () => {
    expect(statusOf(baseConfig, 'lock')).toBeUndefined();
    expect(statusOf(baseConfig, '@arki/lock')).toBe('not-yet');
    expect(statusOf(baseConfig, '@arki/assert')).toBe('candidate');
    expect(statusOf(baseConfig, '@arki/queue')).toBe('private');
  });

  it('fails lock with ADMIT_E001 once it is dropped from notYet', () => {
    const { notYet: _dropped, ...withoutNotYet } = baseConfig;
    const status = statusOf(withoutNotYet, '@arki/lock');
    expect(status).toBe('unadmitted');
    expect(evaluateAdmission('@arki/lock', 'unadmitted').evidence[0]?.code).toBe('ADMIT_E001');
  });

  it('does not warn INV_E004 for a notYet package', () => {
    const env = classifyManifests({ manifests, diagnostics: [], config: baseConfig });
    expect(env.errors.filter(e => e.code === 'INV_E004')).toEqual([]);
  });
});

describe('notYet names', () => {
  it('reports a notYet entry that matches no workspace package', () => {
    const errors = unknownNotYetErrors(
      { ...baseConfig, notYet: [{ name: '@arki/ghost', reason: 'typo' }] },
      new Set(['@arki/assert']),
    );
    expect(errors.map(e => e.code)).toEqual([ADMISSION_ERROR_CODES.unknownNotYet]);
    expect(notYetNames(baseConfig).has('@arki/lock')).toBe(true);
  });
});

describe('validateConfig notYet', () => {
  it('rejects a package listed in a wave and in notYet (CFG_E006)', () => {
    expect(() =>
      validateConfig({ ...baseConfig, notYet: [{ name: '@arki/assert', reason: 'x' }] }),
    ).toThrow(/both `notYet` and the `foundation` wave/);
  });

  it('rejects non-@arki names, empty reasons, and duplicates', () => {
    expect(() => validateConfig({ ...baseConfig, notYet: [{ name: 'lock', reason: 'x' }] })).toThrow(/@arki/);
    expect(() => validateConfig({ ...baseConfig, notYet: [{ name: '@arki/lock', reason: '' }] })).toThrow(/reason/);
    expect(() =>
      validateConfig({
        ...baseConfig,
        notYet: [
          { name: '@arki/lock', reason: 'a' },
          { name: '@arki/lock', reason: 'b' },
        ],
      }),
    ).toThrow(/twice/);
  });

  it('accepts a valid notYet list', () => {
    expect(validateConfig(baseConfig).notYet).toEqual(baseConfig.notYet);
  });
});

describe('validateConfig tiers', () => {
  it('keeps valid tiers and rejects a package listed twice or outside @arki', () => {
    // Why: tiers are the one source for readiness and leaf libraries; a package in both tiers has no defined checklist.
    const tiers = { stack: ['@arki/dot'], libraries: ['@arki/math'] };
    expect(validateConfig({ ...baseConfig, tiers }).tiers).toEqual(tiers);
    expect(() => validateConfig({ ...baseConfig, tiers: { stack: ['@arki/math'], libraries: ['@arki/math'] } })).toThrow(/twice/);
    expect(() => validateConfig({ ...baseConfig, tiers: { stack: ['dot'], libraries: [] } })).toThrow(/@arki/);
    expect(() => validateConfig({ ...baseConfig, tiers: { stack: [] } })).toThrow(/libraries/);
  });
});
