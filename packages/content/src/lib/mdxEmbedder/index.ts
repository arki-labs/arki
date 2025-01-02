import type { Link, Root, Text } from 'mdast';
import type { Plugin } from 'unified';
import type { Node } from 'unist';
import { visit } from 'unist-util-visit';

import type { Provider } from './provider';
import GitHubProvider from './github';
import TwitterProvider from './twitter';

const providers: Provider[] = [TwitterProvider, GitHubProvider];

const getUrlString = (url: string): string | null => {
  const urlString = url.startsWith('http') ? url : `https://${url}`;

  try {
    return new URL(urlString).toString();
  } catch {
    return null;
  }
};

type Options = {};

const mdxEmbedder: Plugin<[Options], Root> = _options => (tree: Node, _file: any, done: () => void) => {
  const tasks: Promise<void>[] = [];

  visit(tree, 'paragraph', (paragraphNode: any) => {
    if (paragraphNode.children.length !== 1) {
      return;
    }

    const { children } = paragraphNode;
    const node = children[0] as Link | Text;
    const isText = node.type === 'text';

    // it's a valid link if there's no title, and the value is the same as the URL
    const isValidLink =
      node.type === 'link' &&
      !node.title &&
      node.children.length === 1 &&
      node.children[0]!.type === 'text' &&
      node.children[0].value === node.url;
    if (!(isText || isValidLink)) {
      return;
    }

    const value = isText ? node.value : node.url;
    const urlString = getUrlString(value);
    if (!urlString) {
      return;
    }

    for (const provider of providers) {
      if (urlString.startsWith(provider.baseUrl)) {
        const result = provider.transform(paragraphNode, urlString);
        if (result) {
          tasks.push(result);
          break;
        }
      }
    }
  });

  Promise.all(tasks).then(() => done());
};

export default mdxEmbedder;
