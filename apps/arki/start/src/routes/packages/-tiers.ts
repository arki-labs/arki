import type { PackageEntry } from '@arki/arki-release/site-schema';

/** The index's row groups, in display order. `null` holds admitted packages no tier has claimed yet. */
export const TIER_GROUPS = [
  { tier: 1, label: 'Tier 1: the stack' },
  { tier: 2, label: 'Tier 2: standalone libraries' },
  { tier: null, label: 'Not in a tier yet' },
] as const satisfies readonly { tier: PackageEntry['tier']; label: string }[];

export function tierLabel(tier: PackageEntry['tier']): string {
  return TIER_GROUPS.find(group => group.tier === tier)?.label ?? 'Not in a tier yet';
}
