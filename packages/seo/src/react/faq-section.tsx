'use client';

import { useState } from 'react';

import { CaretDown } from '@arki/icons/phosphor';
import { cn } from '@arki/ui/cn';

import { FAQSchema } from './faq-schema';

type FAQItem = {
  question: string;
  answer: string;
};

type FAQSectionProps = {
  title?: string;
  description?: string;
  faqs: FAQItem[];
  className?: string;
  /** Whether to include the FAQ schema for SEO */
  includeSchema?: boolean;
  /**
   * Optional progressive disclosure. When set, only the first `initialCount`
   * questions render until the user clicks "Show all". Useful on long pages
   * where the visible accordion would otherwise dominate scroll depth.
   *
   * AEO note: this affects the visible accordion only. If schema is needed
   * for the hidden questions, ensure `includeSchema` is true (or that a
   * separate FAQSchema covers the full set), so search/AI engines still see
   * every question.
   */
  initialCount?: number;
  /** Override the "Show all N questions" / "Show fewer questions" button labels. */
  expandLabel?: (hiddenCount: number) => string;
  collapseLabel?: string;
};

/**
 * FAQ Section component with accordion functionality and optional schema.org markup.
 * Provides both user-friendly UI and SEO-optimized structured data.
 */
export function FAQSection({
  title = 'Frequently Asked Questions',
  description,
  faqs,
  className,
  includeSchema = true,
  initialCount,
  expandLabel = hiddenCount => `Show all ${hiddenCount} more questions`,
  collapseLabel = 'Show fewer questions',
}: FAQSectionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);

  const toggleItem = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  if (faqs.length === 0) return null;

  const isProgressive = typeof initialCount === 'number' && initialCount > 0 && initialCount < faqs.length;
  const visibleFaqs = isProgressive && !showAll ? faqs.slice(0, initialCount) : faqs;
  const hiddenCount = faqs.length - (initialCount ?? faqs.length);

  return (
    <section className={cn('py-12', className)}>
      {includeSchema && <FAQSchema faqs={faqs} />}

      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <h2 className="font-serif text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{title}</h2>
          {description && <p className="mt-4 text-lg text-muted-foreground">{description}</p>}
        </div>

        <div className="divide-y divide-border">
          {visibleFaqs.map((faq, index) => (
            <div key={index} className="py-4">
              <button
                type="button"
                id={`faq-question-${index}`}
                onClick={() => toggleItem(index)}
                className="flex w-full items-center justify-between text-left"
                aria-expanded={openIndex === index}
                aria-controls={`faq-answer-${index}`}
              >
                <span className="pr-4 text-lg font-medium text-foreground">{faq.question}</span>
                <CaretDown
                  aria-hidden="true"
                  className={cn(
                    'h-5 w-5 flex-shrink-0 text-muted-foreground transition-transform duration-200',
                    openIndex === index && 'rotate-180',
                  )}
                />
              </button>

              <div
                id={`faq-answer-${index}`}
                role="region"
                aria-labelledby={`faq-question-${index}`}
                className={cn(
                  'overflow-hidden transition-all duration-200',
                  openIndex === index ? 'mt-4 max-h-96' : 'max-h-0',
                )}
              >
                <p className="text-muted-foreground">{faq.answer}</p>
              </div>
            </div>
          ))}
        </div>

        {isProgressive && (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => setShowAll(prev => !prev)}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2',
                'text-sm font-medium text-foreground shadow-sm transition-colors',
                'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
              aria-expanded={showAll}
            >
              {showAll ? collapseLabel : expandLabel(hiddenCount)}
              <CaretDown
                aria-hidden="true"
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform duration-200',
                  showAll && 'rotate-180',
                )}
              />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Compact FAQ list using native details/summary elements.
 * Suitable for sidebars or smaller sections.
 */
export function FAQCompact({
  faqs,
  className,
  includeSchema = false,
}: {
  faqs: FAQItem[];
  className?: string;
  includeSchema?: boolean;
}) {
  if (faqs.length === 0) return null;

  return (
    <div className={cn('space-y-4', className)}>
      {includeSchema && <FAQSchema faqs={faqs} />}

      {faqs.map((faq, index) => (
        <details key={index} className="group rounded-lg border border-border">
          <summary className="flex cursor-pointer items-center justify-between p-4 font-medium text-foreground">
            {faq.question}
            <CaretDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-border px-4 pb-4 pt-3 text-muted-foreground">
            {faq.answer}
          </div>
        </details>
      ))}
    </div>
  );
}
