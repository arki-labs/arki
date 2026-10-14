import { cn } from '@arki/ui/cn';

import type { EducationalSection } from '../types';

type EducationalContentProps = {
  /** Array of educational sections to render */
  sections: EducationalSection[];
  /** Additional CSS class names */
  className?: string;
};

const CALLOUT_STYLES = {
  info: {
    border: 'border-blue-200 dark:border-blue-800',
    bg: 'bg-blue-50/50 dark:bg-blue-950/30',
    icon: 'ℹ',
    iconColor: 'text-blue-600 dark:text-blue-400',
  },
  warning: {
    border: 'border-amber-200 dark:border-amber-800',
    bg: 'bg-amber-50/50 dark:bg-amber-950/30',
    icon: '⚠',
    iconColor: 'text-amber-600 dark:text-amber-400',
  },
  tip: {
    border: 'border-emerald-200 dark:border-emerald-800',
    bg: 'bg-emerald-50/50 dark:bg-emerald-950/30',
    icon: '💡',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
  },
} as const;

/**
 * Server-rendered educational content with semantic HTML.
 *
 * Renders structured educational sections based on their type:
 * - `text` — heading + paragraph
 * - `list` — heading + paragraph + unordered list
 * - `comparison` — heading + paragraph + description list (dt/dd pairs)
 * - `table` — heading + paragraph + data table
 * - `callout` — highlighted box with icon (info/warning/tip) for key facts
 * - `steps` — numbered step-by-step instructions
 * - `formula` — math formula block with explanation
 * - `stat-highlight` — large-number callout cards for key statistics
 *
 * All output uses semantic HTML elements (h2, p, ul, ol, dl, table) for
 * maximum extractability by search engines and LLM crawlers.
 */
export function EducationalContent({ sections, className }: EducationalContentProps) {
  if (sections.length === 0) return null;

  return (
    <div className={cn('space-y-10', className)}>
      {sections.map((section, index) => (
        <section key={index}>
          <h2 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {section.heading}
          </h2>
          {/* Callout renders content inside a styled box; all others use a standard paragraph */}
          {section.type === 'callout' ? (() => {
            const style = CALLOUT_STYLES[section.variant ?? 'info'];
            return (
              <div className={cn('mt-4 rounded-lg border p-4', style.border, style.bg)}>
                <div className="flex gap-3">
                  <span className={cn('text-lg leading-none', style.iconColor)} aria-hidden="true">
                    {style.icon}
                  </span>
                  <p className="text-sm leading-relaxed text-foreground">{section.content}</p>
                </div>
              </div>
            );
          })() : (
            <p className="mt-3 text-muted-foreground leading-relaxed">{section.content}</p>
          )}

          {section.type === 'list' && Array.isArray(section.items) && (
            <ul className="mt-4 list-disc space-y-1 pl-6 text-muted-foreground">
              {section.items.map((item, i) => (
                <li key={i} className="leading-relaxed">{item}</li>
              ))}
            </ul>
          )}

          {section.type === 'comparison' && section.items && !Array.isArray(section.items) && (
            <dl className="mt-4 space-y-3">
              {Object.entries(section.items).map(([term, definition]) => (
                <div key={term} className="border-b border-border pb-3 last:border-b-0">
                  <dt className="font-medium text-foreground">{term}</dt>
                  <dd className="mt-1 text-muted-foreground">{definition}</dd>
                </div>
              ))}
            </dl>
          )}

          {section.type === 'table' && section.items && !Array.isArray(section.items) && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 pr-4 text-left font-medium text-foreground">Category</th>
                    <th className="py-2 text-left font-medium text-foreground">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(section.items).map(([key, value]) => (
                    <tr key={key} className="border-b border-border last:border-b-0">
                      <td className="py-2 pr-4 text-muted-foreground">{key}</td>
                      <td className="py-2 text-muted-foreground">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {section.type === 'steps' && Array.isArray(section.items) && (
            <ol className="mt-4 list-decimal space-y-3 pl-6 text-muted-foreground">
              {section.items.map((step, i) => (
                <li key={i} className="leading-relaxed pl-1">{step}</li>
              ))}
            </ol>
          )}

          {section.type === 'formula' && section.formula && (
            <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted/30 px-6 py-4">
              <code className="block font-mono text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                {section.formula}
              </code>
            </div>
          )}

          {section.type === 'stat-highlight' && section.items && !Array.isArray(section.items) && (
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {Object.entries(section.items).map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-muted/20 p-4 text-center">
                  <p className="font-mono text-2xl font-bold text-foreground">{value}</p>
                  <p className="mt-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
