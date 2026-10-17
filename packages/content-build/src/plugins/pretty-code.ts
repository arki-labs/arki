import type { Options } from 'rehype-pretty-code';
import type * as unified from 'unified';
import rehypePrettyCode from 'rehype-pretty-code';

// props to https://rehype-pretty-code.netlify.app/

const options: Options = {
  theme: {
    dark: 'github-dark-dimmed',
    light: 'github-light',
  },
  grid: true,
  keepBackground: false,
  onVisitLine(node) {
    // Prevent lines from collapsing in `display: grid` mode, and
    // allow empty lines to be copy/pasted
    if (node.children.length === 0) {
      node.children = [{ type: 'text', value: ' ' }];
    }
  },
};

export const prettyCode: unified.Pluggable = [rehypePrettyCode, options];
