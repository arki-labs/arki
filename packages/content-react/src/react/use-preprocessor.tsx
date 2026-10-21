import type { AnchorHTMLAttributes } from 'react';
import { createElement, Fragment } from 'react';
import rehypeReact from 'rehype-react';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import { useAsyncMemo } from '@arki/ui/hooks/async-memo';

export function useProcessor(text: string) {
  const content = useAsyncMemo(async () => {
    const file = await unified()
      .use(remarkParse)
      .use(remarkRehype)
      .use(rehypeReact, {
        createElement,
        Fragment,
        components: {
          a: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => {
            return (
              <a target="_blank" rel="noreferrer" {...props}>
                {children}
              </a>
            );
          },
        },
      })
      .process(text);

    return file.result;
  }, [text]);

  return content;
}
