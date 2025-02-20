'use client';

import { useProcessor } from '../react/use-preprocessor';

type Props = {
  md?: string;
};

export function Preview({ md }: Props) {
  const Component = useProcessor(md || '');
  return (
    <div className="prose-headings:font-cal prose prose-sm border-input dark:prose-invert h-[158px] w-full overflow-auto rounded-md border px-3 py-2">
      {Component}
    </div>
  );
}
