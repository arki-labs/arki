import { z } from '@arki/contracts';

import type { TweetEmbed } from '../embeds.js';
import { parseWith } from '../utils.js';

/** A tweet as its snapshot stores it: the syndication API's answer, cut to the fields the tweet card shows. */
export const tweetSnapshotSchema = z.object({
  id_str: z.string(),
  text: z.string(),
  created_at: z.string(),
  user: z.object({ name: z.string(), screen_name: z.string(), profile_image_url_https: z.string() }),
});

type TweetSnapshot = z.infer<typeof tweetSnapshotSchema>;

/** The `tweet` prop of `<StaticTweet>`. */
export const tweetProps = (tweet: TweetSnapshot) => ({
  id: tweet.id_str,
  text: tweet.text,
  createdAt: tweet.created_at,
  author: {
    name: tweet.user.name,
    username: tweet.user.screen_name,
    profileImageUrl: tweet.user.profile_image_url_https,
  },
  url: `https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str}`,
});

export type Tweet = ReturnType<typeof tweetProps>;

// https://github.com/vercel/react-tweet/pull/128/files
const getToken = (id: string) => ((Number(id) / 1e15) * Math.PI).toString(6 ** 2).replaceAll(/0+|\./g, '');

/** Fetches a tweet from Twitter's syndication API (no key needed). */
export async function fetchTweet(embed: TweetEmbed): Promise<TweetSnapshot> {
  const response = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${embed.id}&token=${getToken(embed.id)}`,
  );
  if (!response.ok) throw new Error(`Twitter answered ${response.status} ${response.statusText}`);
  return parseWith(tweetSnapshotSchema, await response.json(), `Twitter's answer for ${embed.url}`);
}
