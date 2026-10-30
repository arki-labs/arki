'use client';

import { Button } from '@arki/ui/button';

import { useProcessor } from '../react/use-preprocessor';

type Props = {
  md?: string;
};

export function Preview({ md }: Props) {
  const { value: content, failure, retry } = useProcessor(md || '');
  return (
    <div className="prose-headings:font-cal prose prose-sm h-[158px] w-full overflow-auto rounded-md border border-input px-3 py-2 dark:prose-invert">
      {failure === undefined ? (
        content
      ) : (
        <div role="alert" className="flex items-center gap-2">
          <span>The preview could not be rendered.</span>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
