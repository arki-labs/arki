import type { ComponentProps } from 'react';
import type { TextareaAutosizeProps } from 'react-textarea-autosize';
import TextareaAutosize from 'react-textarea-autosize';

import { cn } from './cn';

export type TextareaWithAutosizeProps = TextareaAutosizeProps;

function TextareaWithAutoSize({ className, ...props }: ComponentProps<typeof TextareaAutosize>) {
  return (
    <TextareaAutosize
      cacheMeasurements
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:ring-ring flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-1 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

TextareaWithAutoSize.displayName = 'Textarea';

export { TextareaWithAutoSize };
