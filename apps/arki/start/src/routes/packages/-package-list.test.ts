import { describe, expect, expectTypeOf, it } from 'vitest';

import { LATEST_SOURCES  } from '@arki/arki-release/site-schema';
import type {PackageEntry} from '@arki/arki-release/site-schema';

import {
  examplesText,
  filterPackages,
  groupByTier,
  runtimesText,
  statusFromSearch,
  STATUS_CHIPS,
  totalLine
  
} from './-package-list';
import type {StatusChip} from './-package-list';

const rows = [
  { short: 'dot', status: 'next', tier: 1, purpose: 'Compose an app from typed plugins.' },
  { short: 'bench', status: 'archive', tier: 2, purpose: 'Benchmarks you can publish.' },
  { short: 'cas', status: 'none', tier: 2, purpose: null },
  { short: 'log', status: 'published', tier: 1, purpose: 'Structured logging.' },
] as const;

describe('status chips', () => {
  it('are `all` plus every package status, so a new status cannot be forgotten', () => {
    expect(STATUS_CHIPS.slice(1)).toEqual([...LATEST_SOURCES]);
    expectTypeOf<Exclude<StatusChip, 'all'>>().toEqualTypeOf<PackageEntry['status']>();
  });
});

describe('statusFromSearch', () => {
  it('keeps a known status and falls back to all for anything else', () => {
    expect(statusFromSearch('archive')).toBe('archive');
    expect(statusFromSearch('bogus')).toBe('all');
    expect(statusFromSearch()).toBe('all');
  });
});

describe('filterPackages', () => {
  it('shows every row when the query is empty and the status is all', () => {
    expect(filterPackages(rows, '  ', 'all').shown).toHaveLength(4);
  });

  it('matches the short name and the purpose line, ignoring case', () => {
    expect(filterPackages(rows, 'PLUGINS', 'all').shown.map(row => row.short)).toEqual(['dot']);
    expect(filterPackages(rows, 'cas', 'all').shown.map(row => row.short)).toEqual(['cas']);
  });

  it('does not match text the page invents for a row without a purpose', () => {
    expect(filterPackages(rows, 'no docs published', 'all').shown).toHaveLength(0);
  });

  it('counts each chip for the query alone, not for the picked status', () => {
    const { shown, chips } = filterPackages(rows, '', 'archive');
    expect(shown.map(row => row.short)).toEqual(['bench']);
    expect(chips).toEqual([
      { id: 'all', count: 4 },
      { id: 'published', count: 1 },
      { id: 'next', count: 1 },
      { id: 'archive', count: 1 },
      { id: 'none', count: 1 },
    ]);
  });
});

describe('groupByTier and totalLine', () => {
  it('orders by tier and leaves out empty groups, so the untiered group stays hidden', () => {
    expect(groupByTier(rows).map(group => group.tier)).toEqual([1, 2]);
    expect(groupByTier([{ tier: null }]).map(group => group.tier)).toEqual([null]);
  });

  it('says how many packages each tier holds', () => {
    expect(totalLine(rows)).toBe('4 packages · 2 in Tier 1 · 2 in Tier 2');
  });
});

describe('row text', () => {
  it('writes examples and runtimes only from data', () => {
    expect(examplesText(null)).toBe('none recorded');
    expect(examplesText({ compiled: 6, run: 0, skipped: 3 })).toBe('6 compiled · 0 run · 3 skipped');
    expect(runtimesText({})).toBeNull();
    expect(runtimesText({ node: '>=22.10' })).toBe('node >=22.10');
  });
});
