'use client';

import React from 'react';

import { Check, Copy, Warning } from '@arki/icons/phosphor';
import { Button } from '@arki/ui/button';
import { cn } from '@arki/ui/cn';
import { copyText } from '@arki/ui/copy-text';

export type PreProps = {} & React.HTMLAttributes<HTMLPreElement>;

export default function Pre({ children, className, ...props }: PreProps) {
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const ref = React.useRef<HTMLPreElement>(null);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (copyState !== 'idle') {
      timer = setTimeout(() => {
        setCopyState('idle');
      }, 2000);
    }
    return () => {
      clearTimeout(timer);
    };
  }, [copyState]);

  const onClick = () => {
    const content = ref.current?.textContent;
    if (!content) return;
    // The check mark shows only once the text is on the clipboard; a refused write shows the failed icon for 2 seconds.
    void copyText(content).then(setCopyState);
  };

  return (
    <div className="relative hidden overflow-hidden dark:[&:has([data-theme='dark'])]:block [&:has([data-theme='light'])]:block dark:[&:has([data-theme='light'])]:hidden">
      <Button
        variant="outline"
        size="icon"
        className="absolute right-2 top-2"
        onClick={onClick}
        aria-label={copyState === 'failed' ? 'Copy failed' : copyState === 'copied' ? 'Copied' : 'Copy code'}
      >
        {copyState === 'copied' ? (
          <Check className="h-5 w-5" />
        ) : copyState === 'failed' ? (
          <Warning className="h-5 w-5" />
        ) : (
          <Copy className="h-5 w-5" />
        )}
      </Button>
      <pre ref={ref} className={cn('[&_code]:grid', className)} {...props}>
        {children}
      </pre>
    </div>
  );
}
