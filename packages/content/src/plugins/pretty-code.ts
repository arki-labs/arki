import type * as unified from 'unified';
import rehypePrettyCode from 'rehype-pretty-code';

// props to https://rehype-pretty-code.netlify.app/

export const prettyCode: unified.Pluggable = [
  rehypePrettyCode,
  {
    theme: 'github-light',
    onVisitLine(node: any) {
      // Prevent lines from collapsing in `display: grid` mode, and
      // allow empty lines to be copy/pasted
      if (node.children.length === 0) {
        node.children = [{ type: 'text', value: ' ' }];
      }
    },
    onVisitHighlightedLine(node: any) {
      node.properties.className.push('highlighted');
    },
    onVisitHighlightedWord(node: any) {
      node.properties.className = ['word'];
    },
  },
];
