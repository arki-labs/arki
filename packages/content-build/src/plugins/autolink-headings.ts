import type * as unified from 'unified';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';

export const autolinkHeadings: unified.Pluggable = [
  rehypeAutolinkHeadings,
  {
    behavior: 'append',
    headingProperties: {
      className: 'group',
    },
    properties: {
      className: [
        "no-underline group-hover:after:content-['#'] after:text-muted-foreground/30 after:hover:text-muted-foreground ml-1 after:p-1",
      ],
      'aria-hidden': 'true',
    },
  },
];
