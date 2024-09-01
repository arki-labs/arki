import * as React from 'react';
import  { type TextareaAutosizeProps } from 'react-textarea-autosize';
import TextareaAutosize from 'react-textarea-autosize';

import { cn } from './cn';

export type TextareaWithAutosizeProps = TextareaAutosizeProps

const TextareaWithAutoSize = React.forwardRef<HTMLTextAreaElement, TextareaWithAutosizeProps>(
  ({ className, ...props }, ref) => {
    return (
      <TextareaAutosize
        cacheMeasurements
        className={cn(
          'flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        // ref={ref}
        {...props}
      />
    );
  },
);
TextareaWithAutoSize.displayName = 'Textarea';

export { TextareaWithAutoSize };
