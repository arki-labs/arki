import type { ReactNode } from 'react';

import { cn } from '@arki/base-ui/cn';

type Props = {
  children: ReactNode;
  className?: string;
};

export const ContentSection = ({ children, className }: Props) => (
  <section
    className={cn(
      'prose-headings:font-cal prose prose-slate dark:prose-invert prose-headings:font-normal prose-pre:my-0 prose-pre:rounded-lg prose-pre:border prose-pre:border-border prose-pre:bg-background prose-img:rounded-lg prose-img:border prose-img:border-border',
      'prose-code:rounded prose-code:border prose-code:px-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
      'prose-code:border-base-300 prose-code:bg-base-100 prose-code:text-base-700',
      'dark:prose-code:border-base-500 dark:prose-code:bg-base-700 dark:prose-code:text-base-100',
      'hover:prose-a:decoration-primary-500 hover:prose-a:decoration-2',
      className,
    )}
  >
    {children}
  </section>
);
