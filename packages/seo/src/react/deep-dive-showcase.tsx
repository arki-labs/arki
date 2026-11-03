import { cn } from '@arki/ui/cn';

import type { DeepDiveExample } from '../types.js';

type DeepDiveShowcaseProps = {
  /** Section title. Defaults to "In-Depth Examples" */
  title?: string;
  /** Array of deep-dive examples to render */
  deepDives: DeepDiveExample[];
  /** Additional CSS class names */
  className?: string;
};

/**
 * Server-rendered rich examples with multi-step calculation walkthroughs.
 *
 * Each deep-dive renders as a self-contained case study with industry context,
 * step-by-step calculations, optional before/after comparisons, and practical
 * decision guidance. Optimized for LLM snippet extraction — each section is
 * written to stand alone.
 *
 * @example
 * ```tsx
 * <DeepDiveShowcase
 *   deepDives={[{
 *     title: "Pouring a 20x20 ft Patio",
 *     industry: "home improvement",
 *     scenario: "A homeowner planning a backyard patio...",
 *     calculationSteps: [
 *       { label: "Area", value: "20 × 20 = 400 sq ft" },
 *       { label: "Volume", value: "400 × (4/12) = 133.3 cu ft" },
 *     ],
 *     decisionGuidance: "For a patio, 4 inches is standard.",
 *   }]}
 * />
 * ```
 */
export function DeepDiveShowcase({
  title = 'In-Depth Examples',
  deepDives,
  className,
}: DeepDiveShowcaseProps) {
  if (deepDives.length === 0) return null;

  return (
    <section className={cn('py-8', className)}>
      <h2 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h2>

      <div className="mt-6 space-y-8">
        {deepDives.map((example, index) => (
          <div key={index} className="rounded-lg border border-border bg-muted/30 p-6">
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-lg font-medium text-foreground">{example.title}</h3>
              {example.industry && (
                <span className="inline-flex flex-shrink-0 items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  {example.industry}
                </span>
              )}
            </div>

            <p className="mt-2 text-muted-foreground leading-relaxed">{example.scenario}</p>

            {/* Calculation steps */}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 pr-4 text-left font-medium text-foreground">Step</th>
                    <th className="py-2 text-left font-medium text-foreground">Calculation</th>
                  </tr>
                </thead>
                <tbody>
                  {example.calculationSteps.map((step, i) => (
                    <tr key={i} className="border-b border-border last:border-b-0">
                      <td className="py-2 pr-4 font-medium text-foreground">{step.label}</td>
                      <td className="py-2 font-mono text-sm text-muted-foreground">{step.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Before/after comparison */}
            {example.comparison && (
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div className="rounded-md border border-border bg-background p-3 text-center">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Before</p>
                  <p className="mt-1 font-mono text-sm text-foreground">{example.comparison.before}</p>
                </div>
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-center">
                  <p className="text-xs font-medium uppercase tracking-wider text-primary">After</p>
                  <p className="mt-1 font-mono text-sm text-foreground">{example.comparison.after}</p>
                </div>
              </div>
            )}

            {/* Decision guidance */}
            <p className="mt-4 text-sm font-medium text-foreground">
              <strong>Decision guidance:</strong>{' '}
              <span className="font-normal text-muted-foreground">{example.decisionGuidance}</span>
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
