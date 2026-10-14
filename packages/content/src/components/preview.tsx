'use client';

import { useProcessor } from '../react/use-preprocessor';

type Props = {
  md?: string;
};

export function Preview({ md }: Props) {
  const Component = useProcessor(md || '');
  return (
    <div className="prose-headings:font-cal prose prose-sm h-[158px] w-full overflow-auto rounded-md border border-input px-3 py-2 dark:prose-invert">
      {Component}
    </div>
  );
}
