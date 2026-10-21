import { describe, expect, it } from 'vitest';

import { buildLlmsFull, buildLlmsIndex, LLMS_INDEX_MAX_LINES, purposeOf } from './-llms';

const entry = { name: '@arki/assert', short: 'assert', status: 'next', npmVersion: null } as const;
const noRelease = { name: '@arki/none', short: 'none', status: 'none', npmVersion: null } as const;

describe('llms index', () => {
  // WHY: agents read /llms.txt whole. A package list that grows past the limit would push the verify commands out.
  it('stays within the line limit for the 33 packages we list today', () => {
    const many = Array.from({ length: 33 }, () => ({ entry, llmsText: '# x\n\n> Does a thing.\n' }));
    const lines = buildLlmsIndex(many, 'https://arki.dev').trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(LLMS_INDEX_MAX_LINES);
  });

  // WHY: a package with no release must say so, not borrow a purpose or a version it does not have.
  it('marks a package with no release and no description', () => {
    const text = buildLlmsIndex([{ entry: noRelease, llmsText: null }], 'https://arki.dev');
    expect(text).toContain('No description yet. (no release yet)');
  });

  it('reads the purpose from the first quote line', () => {
    expect(purposeOf('# t\n\n> One line.\n\n> Other.')).toBe('One line.');
    expect(purposeOf(null)).toBeNull();
  });
});

describe('llms full text', () => {
  // WHY: agents rely on the glossary coming first, so every later term is already defined.
  it('puts the glossary before every package', () => {
    const text = buildLlmsFull('# Glossary', [
      { entry, llmsText: '# @arki/assert', agentGuideText: null, agentsText: null },
    ]);
    expect(text.startsWith('# Glossary')).toBe(true);
    expect(text.indexOf('@arki/assert (next)')).toBeGreaterThan(0);
  });

  // WHY: the agent guide is the task-by-task manual; an agent that loads only llms-full.txt must still get it,
  // right after the package summary it expands on.
  it("puts each package's agent guide after its llms.txt and before its AGENTS.md", () => {
    const text = buildLlmsFull('# Glossary', [
      { entry, llmsText: 'LLMS', agentGuideText: 'GUIDE', agentsText: 'AGENTS' },
    ]);
    expect(text.indexOf('LLMS')).toBeLessThan(text.indexOf('GUIDE'));
    expect(text.indexOf('GUIDE')).toBeLessThan(text.indexOf('AGENTS'));
  });

  it('skips a package that has no release', () => {
    const text = buildLlmsFull('# Glossary', [
      { entry: noRelease, llmsText: 'x', agentGuideText: 'z', agentsText: 'y' },
    ]);
    expect(text).not.toContain('@arki/none');
  });
});
