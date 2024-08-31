import type * as unified from 'unified';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';

export const autolinkHeadings: unified.Pluggable = [
  rehypeAutolinkHeadings,
  {
    behavior: 'append',
    properties: {
      className: [
        "no-underline after:content-['#'] after:text-muted-foreground/50 after:hover:text-muted-foreground ml-1 after:p-1",
      ],
    },
  },
];
