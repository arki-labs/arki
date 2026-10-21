import { describe, expect, it } from 'vitest';

import protocol from '~/content/agent-bench/PROTOCOL.md?raw';
import { summarizeProtocol } from './-protocol-summary';

describe('summarizeProtocol', () => {
  it('reads the shipped protocol: three claims, six tasks, three stacks, two agents', () => {
    const summary = summarizeProtocol(protocol);
    expect(summary.protocolId).toBe('AB-PROTO-1');
    expect(summary.claims.map(claim => claim.id)).toEqual(['AB-C1', 'AB-C2', 'AB-C3']);
    expect(summary.tasks.map(task => task.id)).toEqual(['AB-T01', 'AB-T02', 'AB-T03', 'AB-T04', 'AB-T05', 'AB-T06']);
    expect(summary.stacks.map(stack => stack.id)).toEqual(['AB-S1', 'AB-S2', 'AB-S3']);
    expect(summary.agents.map(agent => agent.id)).toEqual(['AB-A1', 'AB-A2']);
    expect(summary.claim.startsWith('We test one claim')).toBe(true);
    expect(summary.design.find(row => row.item === 'Wall time cap')?.value).toBe('45 minutes per run');
  });

  it('takes every value from the markdown it is given, so the page cannot drift from the file', () => {
    const markdown = [
      'Protocol ID: `X-1`.',
      '## 1. Claim',
      'One claim.',
      '| Id | Condition |',
      '| --- | --- |',
      '| C1 | A \\| B |',
      '## 3. Arms',
      '| Id | Stack | Start |',
      '| --- | --- | --- |',
      '| S1 | Alpha | x |',
      '## 4. Agents',
      '| Id | Harness | Model ID | Verification |',
      '| --- | --- | --- | --- |',
      '| A1 | H | `m` | ok |',
      '## 5. Tasks',
      '| Id | Task |',
      '| --- | --- |',
      '| T1 | Do it |',
      '## 6. Design',
      '| Item | Value |',
      '| --- | --- |',
      ...[
        'Cells',
        'Repeats per cell',
        'Total runs',
        'Order',
        'Wall time cap',
        'Cost cap',
        'Tool-call cap',
        'Human feedback',
        'Total budget',
      ].map(item => `| ${item} | v-${item} |`),
      '## Amendments',
      '',
      'None.',
    ].join('\n');
    const summary = summarizeProtocol(markdown);
    expect(summary.claims).toEqual([{ id: 'C1', text: 'A | B' }]);
    expect(summary.stacks).toEqual([{ id: 'S1', name: 'Alpha' }]);
    expect(summary.design[0]).toEqual({ item: 'Cells', value: 'v-Cells' });
    expect(summary.amendmentsNone).toBe(true);
  });

  it('fails loudly when a section is missing', () => {
    expect(() => summarizeProtocol('Protocol ID: `X`.\n## 1. Claim\ntext')).toThrow('has no section');
  });
});
