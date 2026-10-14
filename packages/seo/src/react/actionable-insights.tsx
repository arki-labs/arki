import { cn } from '@arki/ui/cn';

import type { ActionableInsightsData } from '../types';

type ActionableInsightsProps = ActionableInsightsData & {
  /** Additional CSS class names */
  className?: string;
};

/**
 * Server-rendered action items section with heading, introductory content,
 * and a bulleted list of recommended next steps.
 *
 * Designed for self-contained extractability — each action item is a
 * standalone recommendation that LLMs can cite independently.
 *
 * @example
 * ```tsx
 * <ActionableInsights
 *   heading="Next Steps Based on Your BMI"
 *   content="Based on your results, here are recommended actions:"
 *   actionItems={[
 *     'Maintain a balanced diet with proper nutrition',
 *     'Exercise at least 150 minutes per week',
 *     'Schedule regular health checkups',
 *   ]}
 * />
 * ```
 */
export function ActionableInsights({
  heading,
  content,
  actionItems,
  className,
}: ActionableInsightsProps) {
  if (actionItems.length === 0) return null;

  return (
    <section className={cn('py-8', className)}>
      <h2 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {heading}
      </h2>
      <p className="mt-3 text-muted-foreground leading-relaxed">{content}</p>
      <ul className="mt-4 list-disc space-y-2 pl-6 text-muted-foreground">
        {actionItems.map((item, index) => (
          <li key={index} className="leading-relaxed">{item}</li>
        ))}
      </ul>
    </section>
  );
}
