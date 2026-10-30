import type { AnchorHTMLAttributes } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import rehypeReact from 'rehype-react';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import { useAsyncMemo } from '@arki/ui/hooks/async-memo';

/** Renders markdown text to React. Returns the content, `isPending`, `failure` (what the pipeline rejected with) and `retry()`. */
export function useProcessor(text: string) {
  return useAsyncMemo(async () => {
    const file = await unified()
      .use(remarkParse)
      .use(remarkRehype)
      .use(rehypeReact, {
        Fragment,
        jsx,
        jsxs,
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
}
