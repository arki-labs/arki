import { defineSuite, size } from '@arki/bench';

// @arki/bench is a dev tool: its speed is mitata's (it times with mitata's
// `measure`), so the honest comparison is what each tool adds to a bundle
// when a benchmark runs in a browser or on React Native.
export default defineSuite({
  id: '@arki/bench',
  intro:
    'What the portable core adds to a browser bundle (minified, then compressed file by file), next to the timing libraries people reach for. Timing itself is mitata: `@arki/bench` calls its `measure`, so per-operation overhead is the same.',
  notes: [
    'The rivals are timing libraries only. They have no contract check, no bootstrap intervals, no verdicts and no README rendering, so they are shown but not ranked.',
  ],
  groups: [
    size({
      id: 'core',
      title: 'Define, run and render a suite',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/bench/core',
          package: '@arki/bench',
          limit: '21 kB',
          source: "export { compare, defineSuite, renderMarkdown, renderText, runSuite } from '@arki/bench/core';",
        },
        mitata: {
          label: 'mitata (bench, run)',
          package: 'mitata',
          differs: 'timing and console output only',
          source: "export { bench, run, summary } from 'mitata';",
        },
        tinybench: {
          label: 'tinybench (Bench)',
          package: 'tinybench',
          differs: 'timing and a results table only',
          source: "export { Bench } from 'tinybench';",
        },
      },
    }),
  ],
});
