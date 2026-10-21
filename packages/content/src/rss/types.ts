/** A link attached to a feed or an item (`<link>`, Atom `<link rel>`, RSS `<enclosure>`). */
export type FeedLink = {
  href: string;
  /** Atom `rel`. RSS `<enclosure>` is normalised to `rel: 'enclosure'`. */
  rel?: string;
  type?: string;
  /** Size in bytes, when the source gives one. */
  length?: number;
}

export type FeedPerson = {
  name: string;
  email?: string;
  url?: string;
}

/** An element the core model does not know, such as `itunes:image` or `dc:creator`. */
export type FeedExtension = {
  text: string;
  attributes: Record<string, string>;
}

/** Extension elements by prefixed name, for example `itunes:duration`. */
export type FeedExtensions = Record<string, FeedExtension[]>;

export type FeedItem = {
  /** RSS `guid` or Atom `id`. */
  id?: string;
  title: string;
  /** The page this item describes (RSS `link`, Atom `link rel="alternate"`). */
  link?: string;
  /** Short text: RSS `description`, Atom `summary`. */
  summary?: string;
  /** Full body: RSS `content:encoded`, Atom `content`. */
  content?: string;
  published?: Date;
  updated?: Date;
  authors: FeedPerson[];
  categories: string[];
  /** Other links, including enclosures. */
  links: FeedLink[];
  extensions: FeedExtensions;
}

export type Feed = {
  /** Which wire format this feed was read from. Writers take the format as an argument. */
  format: 'rss' | 'atom';
  /** Atom `id`. */
  id?: string;
  title: string;
  description?: string;
  /** The site this feed belongs to. */
  link?: string;
  language?: string;
  copyright?: string;
  generator?: string;
  /** Minutes a reader may cache the feed (RSS `ttl`). */
  ttl?: number;
  managingEditor?: string;
  webMaster?: string;
  /** Feed image or logo URL. */
  image?: string;
  updated?: Date;
  authors: FeedPerson[];
  /** Other links, such as `rel="self"` and `rel="next"`. */
  links: FeedLink[];
  extensions: FeedExtensions;
  /** Namespace prefixes to URIs. The writer adds the ones it knows (`atom`, `content`, `dc`, `itunes`). */
  namespaces: Record<string, string>;
  items: FeedItem[];
}

export type FeedErrorCode = 'FEED_TOO_LARGE' | 'FEED_MALFORMED' | 'FEED_UNSUPPORTED' | 'FEED_LIMIT_EXCEEDED';

export class FeedError extends Error {
  readonly code: FeedErrorCode;

  constructor(code: FeedErrorCode, message: string) {
    super(message);
    this.name = 'FeedError';
    this.code = code;
  }
}

export type ParseFeedOptions = {
  /** Reject input larger than this many bytes of UTF-8. Default 10 MiB. */
  maxBytes?: number;
  /** Reject feeds with more items than this. Default 10000. */
  maxItems?: number;
}
