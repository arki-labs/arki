'use client';

import React from 'react';

import { Check, Copy, Warning } from '@arki/icons/phosphor';
import { Button } from '@arki/ui/button';
import { cn } from '@arki/ui/cn';

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
    // The check mark shows only once the text is on the clipboard. A refused write, or a page with no
    // clipboard (plain http), leaves the copy icon and shows the failed icon for 2 seconds.
    const clipboard: Clipboard | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setCopyState('failed');
      return;
    }
    clipboard.writeText(content).then(
      () => {
        setCopyState('copied');
      },
      () => {
        setCopyState('failed');
      },
    );
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
