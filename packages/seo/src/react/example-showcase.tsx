import type React from 'react';

import { cn } from '@arki/ui/cn';

import type { ExampleItem } from '../types';

type ExampleShowcaseProps = {
  /** Section title. Defaults to "Examples" */
  title?: string;
  /** Array of worked examples */
  examples: ExampleItem[];
  /** Additional CSS class names */
  className?: string;
  /** Render prop for an interactive action on examples that have `inputs`.
   *  Receives the example's input values and returns a React node (typically a client button).
   *  This keeps ExampleShowcase as a server component while allowing interactive islands. */
  renderExampleAction?: (inputs: Record<string, unknown>) => React.ReactNode;
};

/**
 * Server-rendered worked examples with self-contained paragraphs.
 *
 * Each example renders as a self-contained block with scenario, explanation,
 * and takeaway — optimized for LLM snippet extraction. LLMs tend to cite
 * individual paragraphs, so each section is written to stand alone.
 *
 * @example
 * ```tsx
 * <ExampleShowcase
 *   title="Calculation Examples"
 *   examples={[
 *     {
 *       heading: 'BMI Calculation',
 *       scenario: 'A person who is 5\'10" and weighs 165 lbs.',
 *       explanation: 'The BMI formula yields 23.7, which falls in the normal range.',
 *       takeaway: 'A BMI between 18.5 and 24.9 indicates a healthy weight.',
 *     },
 *   ]}
 * />
 * ```
 */
export function ExampleShowcase({
  title = 'Examples',
  examples,
  className,
  renderExampleAction,
}: ExampleShowcaseProps) {
  if (examples.length === 0) return null;

  return (
    <section className={cn('py-8', className)}>
      <h2 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h2>

      <div className="mt-6 space-y-8">
        {examples.map((example, index) => (
          <div key={index} className="rounded-lg border border-border bg-muted/30 p-6">
            <h3 className="text-lg font-medium text-foreground">{example.heading}</h3>
            <p className="mt-2 text-muted-foreground leading-relaxed">{example.scenario}</p>
            <p className="mt-3 text-muted-foreground leading-relaxed">{example.explanation}</p>
            <p className="mt-3 text-sm font-medium text-foreground">
              <strong>Key takeaway:</strong>{' '}
              <span className="font-normal text-muted-foreground">{example.takeaway}</span>
            </p>
            {example.inputs && renderExampleAction && (
              <div className="mt-4 border-t border-border pt-4">
                {renderExampleAction(example.inputs)}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
