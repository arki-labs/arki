import { XIcon } from '@arki/icons/phosphor';

import DateTime from './DateTime.js';
import EmbeddedCard from './EmbeddedCard.js';

/**
 * A tweet as the card shows it. `@arki/content-build` writes these props into the compiled MDX from the embed
 * snapshot (`src/content/.embeds/`), so the fields match its `tweetProps`.
 */
export type Tweet = {
  id: string;
  text: string;
  createdAt: string;
  author: { name: string; username: string; profileImageUrl: string };
  url: string;
};

type Props = {
  tweet: Tweet;
};

export const StaticTweet = ({ tweet }: Props) => (
  <EmbeddedCard href={tweet.url} className="gap-5">
    <EmbeddedCard.Title icon={XIcon}>
      <p className="text-base-500 dark:text-base-400">
        Tweet from <DateTime value={tweet.createdAt} />
      </p>
    </EmbeddedCard.Title>
    <blockquote dangerouslySetInnerHTML={{ __html: tweet.text }} />
    <EmbeddedCard.Author
      name={tweet.author.name}
      avatar={{ src: tweet.author.profileImageUrl, alt: `Profile of ${tweet.author.name}` }}
    />
  </EmbeddedCard>
);
