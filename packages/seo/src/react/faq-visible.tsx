import { cn } from '@arki/ui/cn';

import { FAQSchema } from './faq-schema.js';
import type { FAQItem } from '../types.js';

type FAQVisibleProps = {
  /** Section title. Defaults to "Frequently Asked Questions" */
  title?: string;
  /** Optional description below the title */
  description?: string;
  /** Array of question/answer pairs */
  faqs: FAQItem[];
  /** Additional CSS class names */
  className?: string;
  /** Whether to include FAQPage schema.org markup for rich results. Defaults to true */
  includeSchema?: boolean;
};

/**
 * Server-rendered FAQ section with all answers visible in static HTML.
 *
 * Unlike FAQSection (accordion) and FAQCompact (details/summary), this component
 * renders all Q&A pairs as visible h3 + p elements without any JavaScript toggling.
 * This is critical for:
 * - LLM crawlers (GPTBot, ClaudeBot, PerplexityBot) that don't execute JS
 * - Google's initial HTML indexing pass
 * - Content extractability by AI search systems
 *
 * Use this component for primary page FAQs. Use FAQSection/FAQCompact for
 * supplementary or sidebar FAQs where space conservation matters.
 *
 * @example
 * ```tsx
 * <FAQVisible
 *   title="Frequently Asked Questions about BMI"
 *   faqs={[
 *     { question: 'What is BMI?', answer: 'BMI stands for Body Mass Index...' },
 *     { question: 'How is BMI calculated?', answer: 'BMI is calculated by...' },
 *   ]}
 * />
 * ```
 */
export function FAQVisible({
  title = 'Frequently Asked Questions',
  description,
  faqs,
  className,
  includeSchema = true,
}: FAQVisibleProps) {
  if (faqs.length === 0) return null;

  return (
    <section className={cn('py-12', className)}>
      {includeSchema && <FAQSchema faqs={faqs} />}

      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <h2 className="font-serif text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            {title}
          </h2>
          {description && (
            <p className="mt-4 text-lg text-muted-foreground">{description}</p>
          )}
        </div>

        <div className="space-y-8">
          {faqs.map((faq, index) => (
            <div key={index} className="border-b border-border pb-6 last:border-b-0">
              <h3 className="text-lg font-medium text-foreground">{faq.question}</h3>
              <p className="mt-2 text-muted-foreground leading-relaxed">{faq.answer}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
