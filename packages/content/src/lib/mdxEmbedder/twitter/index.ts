import type { Paragraph } from 'mdast';

import type { Provider } from '../provider.js';
import { createJSONParseAST } from '../utils.js';
import fetchTweet from './fetchTweets.js';

export type Tweet = Awaited<ReturnType<typeof fetchTweet>>;

const getIdFromUrl = (url: string) => {
  const parts = url.split('/');
  const lastPart = parts.at(-1);
  const index = lastPart?.indexOf('?');
  if (index && index > 0 && lastPart) {
    return lastPart.slice(0, Math.max(0, index));
  }
  return lastPart;
};

const fetchAndTransform = async (node: Paragraph, id: string) => {
  const tweet = await fetchTweet(id);

  Object.assign(node, {
    type: 'mdxJsxFlowElement',
    name: 'StaticTweet',
    attributes: [
      {
        type: 'mdxJsxAttribute',
        name: 'tweet',
        value: {
          type: 'mdxJsxAttributeValueExpression',
          data: {
            estree: createJSONParseAST(JSON.stringify(tweet)),
          },
        },
      },
    ],
    children: [],
    position: {},
  });
};

const TwitterProvider: Provider = {
  baseUrl: 'https://twitter.com',
  transform(node, url) {
    const id = getIdFromUrl(url);
    if (!id) {
      return null;
    }

    return fetchAndTransform(node, id);
  },
};

export default TwitterProvider;
