import type { ReactNode } from 'react';

import { cn } from '@arki/ui/cn';

import { ActionableInsights } from './actionable-insights.js';
import { DeepDiveShowcase } from './deep-dive-showcase.js';
import { EducationalContent } from './educational-content.js';
import { ExampleShowcase } from './example-showcase.js';
import { FAQVisible } from './faq-visible.js';
import { HowToSchema } from './howto-schema.js';
import type {
  ActionableInsightsData,
  DeepDiveExample,
  EducationalSection,
  ExampleItem,
  FAQItem,
  HowToStep,
} from '../types.js';

/** Props for the ToolSEOContent composite component */
export type ToolSEOContentProps = {
  educationalContent?: EducationalSection[];
  examples?: ExampleItem[];
  actionableInsights?: ActionableInsightsData;
  faqs?: FAQItem[];
  howToSteps?: HowToStep[];
  howToName?: string;
  howToDescription?: string;
  faqTitle?: string;
  examplesTitle?: string;
  /** Render prop for interactive "try this example" actions. Passed through to ExampleShowcase. */
  renderExampleAction?: (inputs: Record<string, unknown>) => ReactNode;
  className?: string;

  /** Rich deep-dive examples with multi-step calculations */
  deepDives?: DeepDiveExample[];
};

/**
 * Composite server component that assembles all SEO content sections for a tool page.
 *
 * This standardizes the "below the tool/calculator" content pattern across all apps.
 * It renders sections in a consistent order optimized for both user experience and
 * search engine / LLM extractability:
 *
 * 1. Educational content (text, lists, tables, comparisons)
 * 2. Worked examples
 * 3. Actionable insights / next steps
 * 4. HowTo schema (invisible, JSON-LD only)
 * 5. FAQ section (visible, with FAQPage schema)
 *
 * Each section is independently optional — only provided sections render.
 *
 * @example
 * ```tsx
 * <ToolSEOContent
 *   educationalContent={alias.educationalContent}
 *   examples={alias.examples.map(e => ({ heading: e.heading, scenario: e.scenario, explanation: e.explanation, takeaway: e.takeaway }))}
 *   actionableInsights={alias.actionableInsights}
 *   faqs={alias.faqs}
 *   howToSteps={[{ name: 'Enter values', text: 'Input your height and weight' }]}
 *   howToName="How to Calculate BMI"
 *   howToDescription="Step-by-step guide to using the BMI Calculator"
 * />
 * ```
 */
export function ToolSEOContent({
  educationalContent,
  examples,
  actionableInsights,
  faqs,
  howToSteps,
  howToName,
  howToDescription,
  faqTitle,
  examplesTitle,
  renderExampleAction,
  className,
  deepDives,
}: ToolSEOContentProps) {
  const hasContent =
    (educationalContent && educationalContent.length > 0) ||
    (examples && examples.length > 0) ||
    (actionableInsights && actionableInsights.actionItems.length > 0) ||
    (howToSteps && howToSteps.length > 0) ||
    (faqs && faqs.length > 0) ||
    (deepDives && deepDives.length > 0);

  if (!hasContent) return null;

  return (
    <div className={cn('mx-auto max-w-4xl px-4', className)}>
      {educationalContent && educationalContent.length > 0 && (
        <EducationalContent sections={educationalContent} className="py-8" />
      )}

      {examples && examples.length > 0 && (
        <ExampleShowcase examples={examples} title={examplesTitle} renderExampleAction={renderExampleAction} />
      )}

      {deepDives && deepDives.length > 0 && (
        <DeepDiveShowcase deepDives={deepDives} />
      )}

      {actionableInsights && actionableInsights.actionItems.length > 0 && (
        <ActionableInsights
          heading={actionableInsights.heading}
          content={actionableInsights.content}
          actionItems={actionableInsights.actionItems}
        />
      )}

      {howToSteps && howToSteps.length > 0 && howToName && howToDescription && (
        <HowToSchema
          name={howToName}
          description={howToDescription}
          steps={howToSteps}
        />
      )}

      {faqs && faqs.length > 0 && (
        <FAQVisible faqs={faqs} title={faqTitle} />
      )}
    </div>
  );
}
