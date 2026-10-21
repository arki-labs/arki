import type { ComponentProps } from 'react';

import type { PackageEntry } from '@arki/arki-release/site-schema';

import type { Pill } from '~/shared/site-chrome';

import { TIER_GROUPS } from './-tiers';

/** The status chips of the index filter, in display order. `all` first, then every `PackageEntry` status. */
export const STATUS_CHIPS = ['all', 'published', 'next', 'archive', 'none'] as const;
export type StatusChip = (typeof STATUS_CHIPS)[number];

/** The chip a `?status=` value names; a missing or unknown value is `all`. */
export function statusFromSearch(value?: string): StatusChip {
  return STATUS_CHIPS.find(chip => chip === value) ?? 'all';
}

export type PillKind = ComponentProps<typeof Pill>['kind'];

/** How a status is drawn: pill colour pair and a glyph, so the status never rests on colour alone. */
export const STATUS_PILL = {
  published: { kind: 'st-published', glyph: '●' },
  next: { kind: 'st-next', glyph: '◐' },
  archive: { kind: 'st-archive', glyph: '▪' },
  none: { kind: 'st-none', glyph: '–' },
} as const satisfies Record<PackageEntry['status'], { kind: PillKind; glyph: string }>;

type Filterable = Pick<PackageEntry, 'short' | 'status' | 'tier'> & { purpose: string | null };

/**
 * Applies the index filter. A row matches the query when the query is part of its short name or of its purpose line.
 * `chips` counts the rows each status chip would show for the query alone, so the counts stay visible while a status
 * is picked.
 */
export function filterPackages<Row extends Filterable>(rows: readonly Row[], query: string, status: StatusChip) {
  const needle = query.trim().toLowerCase();
  const matching = rows.filter(
    row => needle === '' || row.short.includes(needle) || (row.purpose ?? '').toLowerCase().includes(needle),
  );
  const withStatus = (chip: StatusChip) => matching.filter(row => chip === 'all' || row.status === chip);
  return {
    shown: withStatus(status),
    chips: STATUS_CHIPS.map(id => ({ id, count: withStatus(id).length })),
  };
}

/** Rows split by tier in display order; a group with no rows is left out. */
export function groupByTier<Row extends Pick<PackageEntry, 'tier'>>(rows: readonly Row[]) {
  return TIER_GROUPS.map(group => ({ ...group, rows: rows.filter(row => row.tier === group.tier) })).filter(
    group => group.rows.length > 0,
  );
}

/** `30 packages · 12 in Tier 1 · 18 in Tier 2`. A tier with no package is left out. */
export function totalLine(rows: readonly Pick<PackageEntry, 'tier'>[]): string {
  const parts = groupByTier(rows).map(
    group => `${group.rows.length} ${group.tier === null ? 'not in a tier yet' : `in Tier ${group.tier}`}`,
  );
  return [`${rows.length} packages`, ...parts].join(' · ');
}

/** `none recorded`, or `6 compiled · 0 run · 3 skipped`. */
export function examplesText(examples: PackageEntry['examples']): string {
  if (examples === null) return 'none recorded';
  return `${examples.compiled} compiled · ${examples.run} run · ${examples.skipped} skipped`;
}

/** `node >=22.10, bun >=1.3`, or null when the package declares no runtime. */
export function runtimesText(runtimes: PackageEntry['runtimes']): string | null {
  const entries = Object.entries(runtimes);
  if (entries.length === 0) return null;
  return entries.map(([runtime, range]) => `${runtime} ${range}`).join(', ');
}
