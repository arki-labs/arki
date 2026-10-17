/**
 * Calibration of `grounded` against human labels. 36 labelled claims (24 easy, 12 hard) over two
 * sources. A claim labelled supported must pass (true positive); one labelled unsupported must
 * fail (true negative). A judge scorer may only gate a build once both rates clear 0.9.
 */
import { describe, expect, it } from 'vitest';

import type { FaithfulnessCase } from './__fixtures__/claims.js';
import { faithfulnessCases, hardFaithfulnessCases, sourceA, sourceB } from './__fixtures__/claims.js';
import { createJudge } from './judge.js';
import { grounded } from './scorers.js';

const MODEL = 'gemma4:latest';

async function calibrate(cases: readonly FaithfulnessCase[]) {
  const judge = await createJudge({ model: MODEL });
  const results = [];
  for (const labelled of cases) {
    const source = labelled.source === 'A' ? sourceA : sourceB;
    const score = await grounded({ source }).score(
      { output: labelled.claim, input: undefined, expected: undefined },
      { judge },
    );
    // An unscorable claim is no evidence of support: it counts as not passing.
    results.push({
      id: labelled.id,
      label: labelled.label,
      kind: labelled.kind,
      passed: score.status === 'scored' && score.pass,
      status: score.status,
    });
  }
  const supported = results.filter(result => result.label === 'supported');
  const unsupported = results.filter(result => result.label === 'unsupported');
  const tpr = supported.filter(result => result.passed).length / supported.length;
  const tnr = unsupported.filter(result => !result.passed).length / unsupported.length;
  const wrong = results
    .filter(result => result.passed !== (result.label === 'supported'))
    .map(result => `${result.id} (${result.kind})`);
  process.stdout.write(
    `grounded calibration ${cases.length} claims: TPR ${tpr.toFixed(3)}, TNR ${tnr.toFixed(3)}, wrong: ${wrong.join(', ') || 'none'}\n`,
  );
  return { tpr, tnr, wrong };
}

describe('grounded calibration (gemma4 as judge)', () => {
  it(
    'catches 90% of the fabrications and keeps 90% of the faithful claims, on all 36 labelled claims',
    { timeout: 600_000 },
    async () => {
      const all = await calibrate([...faithfulnessCases, ...hardFaithfulnessCases]);
      expect(all.tpr, `wrong: ${all.wrong.join(', ')}`).toBeGreaterThanOrEqual(0.9);
      expect(all.tnr, `wrong: ${all.wrong.join(', ')}`).toBeGreaterThanOrEqual(0.9);
    },
  );

  it('holds on the 12 hard claims alone (trivial follow-ons, plausible inferences)', { timeout: 600_000 }, async () => {
    const hard = await calibrate(hardFaithfulnessCases);
    expect(hard.tpr, `wrong: ${hard.wrong.join(', ')}`).toBeGreaterThanOrEqual(0.9);
    expect(hard.tnr, `wrong: ${hard.wrong.join(', ')}`).toBeGreaterThanOrEqual(0.9);
  });
});
