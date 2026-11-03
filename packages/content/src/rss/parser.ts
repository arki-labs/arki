import { XMLParser, XMLValidator } from 'fast-xml-parser';

import type {
  Feed,
  FeedExtension,
  FeedExtensions,
  FeedItem,
  FeedLink,
  FeedPerson,
  ParseFeedOptions,
} from './types.js';
import { FeedLimitExceeded, FeedMalformed, FeedTooLarge, FeedUnsupported } from './types.js';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ITEMS = 10_000;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const node = (value: unknown): Node => (isNode(value) ? value : {});
const list = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  const inner = node(value)['#text'];
  return typeof inner === 'string' ? inner : '';
}

const optional = (value: string): string | undefined => (value === '' ? undefined : value);

function date(value: unknown): Date | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function link(value: unknown): FeedLink | undefined {
  const row = node(value);
  const href = text(row['@href']) || text(row['@url']);
  if (!href) return undefined;
  const length = Number(text(row['@length']));
  const result: FeedLink = { href };
  const rel = optional(text(row['@rel']));
  const type = optional(text(row['@type']));
  if (rel) result.rel = rel;
  if (type) result.type = type;
  if (text(row['@length']) && Number.isFinite(length)) result.length = length;
  return result;
}

function person(value: unknown): FeedPerson | undefined {
  const row = node(value);
  const name = text(row.name) || text(value);
  if (!name) return undefined;
  const result: FeedPerson = { name };
  const email = optional(text(row.email));
  const url = optional(text(row.uri));
  if (email) result.email = email;
  if (url) result.url = url;
  return result;
}

const KNOWN_KEYS = new Set([
  'title',
  'description',
  'subtitle',
  'summary',
  'content',
  'link',
  'guid',
  'id',
  'pubDate',
  'published',
  'updated',
  'lastBuildDate',
  'author',
  'managingEditor',
  'webMaster',
  'category',
  'enclosure',
  'entry',
  'item',
  'language',
  'copyright',
  'rights',
  'generator',
  'ttl',
  'image',
  'logo',
  'icon',
  'content:encoded',
  'dc:creator',
  'atom:link',
]);

function extensions(row: Node): FeedExtensions {
  const result: FeedExtensions = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('@') || key === '#text' || KNOWN_KEYS.has(key)) continue;
    if (!key.includes(':') || key.startsWith('xmlns')) continue;
    result[key] = list(value).map((entry): FeedExtension => {
      const attributes: Record<string, string> = {};
      for (const [name, attr] of Object.entries(node(entry))) {
        if (name.startsWith('@')) attributes[name.slice(1)] = text(attr);
      }
      return { text: text(entry), attributes };
    });
  }
  return result;
}

function namespaces(root: Node): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith('@xmlns:')) result[key.slice('@xmlns:'.length)] = text(value);
  }
  return result;
}

function categories(value: unknown, atom: boolean): string[] {
  return list(value)
    .map(entry => (atom ? text(node(entry)['@term']) : text(entry)))
    .filter(Boolean);
}

function rssItem(row: Node): FeedItem {
  const authors = [...list(row['dc:creator']), ...list(row.author)]
    .map(entry => text(entry))
    .filter(Boolean)
    .map((name): FeedPerson => ({ name }));
  const links = list(row.enclosure).flatMap(entry => {
    const parsed = link(entry);
    return parsed ? [{ ...parsed, rel: 'enclosure' }] : [];
  });
  const item: FeedItem = {
    title: text(row.title),
    authors,
    categories: categories(row.category, false),
    links,
    extensions: extensions(row),
  };
  const id = optional(text(row.guid));
  const url = optional(text(row.link));
  const summary = optional(text(row.description));
  const content = optional(text(row['content:encoded']));
  const published = date(row.pubDate);
  if (id) item.id = id;
  if (url) item.link = url;
  if (summary) item.summary = summary;
  if (content) item.content = content;
  if (published) item.published = published;
  return item;
}

function atomItem(row: Node): FeedItem {
  const links = list(row.link).flatMap(entry => {
    const parsed = link(entry);
    return parsed ? [parsed] : [];
  });
  const alternate = links.find(l => l.rel === undefined || l.rel === 'alternate');
  const item: FeedItem = {
    title: text(row.title),
    authors: list(row.author).flatMap(entry => {
      const parsed = person(entry);
      return parsed ? [parsed] : [];
    }),
    categories: categories(row.category, true),
    links: links.filter(l => l !== alternate),
    extensions: extensions(row),
  };
  const id = optional(text(row.id));
  const summary = optional(text(row.summary));
  const content = optional(text(row.content));
  const published = date(row.published);
  const updated = date(row.updated);
  if (id) item.id = id;
  if (alternate) item.link = alternate.href;
  if (summary) item.summary = summary;
  if (content) item.content = content;
  if (published) item.published = published;
  if (updated) item.updated = updated;
  return item;
}

function rssFeed(root: Node, channel: Node): Feed {
  const items = list(channel.item);
  const links = list(channel.link).flatMap(entry => {
    // Plain RSS <link> is text; Atom-namespaced links are objects with attributes.
    const parsed = typeof entry === 'string' ? undefined : link(entry);
    return parsed ? [parsed] : [];
  });
  const siteLink = list(channel.link)
    .filter((entry): entry is string => typeof entry === 'string')
    .find(Boolean);
  const feed: Feed = {
    format: 'rss',
    title: text(channel.title),
    authors: [],
    links: [...links, ...list(channel['atom:link']).flatMap(entry => link(entry) ?? [])],
    extensions: extensions(channel),
    namespaces: namespaces(root),
    items: items.map(entry => rssItem(node(entry))),
  };
  const description = optional(text(channel.description));
  const language = optional(text(channel.language));
  const copyright = optional(text(channel.copyright));
  const generator = optional(text(channel.generator));
  const managingEditor = optional(text(channel.managingEditor));
  const webMaster = optional(text(channel.webMaster));
  const image = optional(text(node(channel.image).url));
  const updated = date(channel.lastBuildDate) ?? date(channel.pubDate);
  const ttl = Number(text(channel.ttl));
  if (description) feed.description = description;
  if (siteLink) feed.link = siteLink;
  if (language) feed.language = language;
  if (copyright) feed.copyright = copyright;
  if (generator) feed.generator = generator;
  if (managingEditor) feed.managingEditor = managingEditor;
  if (webMaster) feed.webMaster = webMaster;
  if (image) feed.image = image;
  if (updated) feed.updated = updated;
  if (text(channel.ttl) && Number.isFinite(ttl)) feed.ttl = ttl;
  return feed;
}

function atomFeed(root: Node, channel: Node): Feed {
  const entries = list(channel.entry);
  const links = list(channel.link).flatMap(entry => {
    const parsed = link(entry);
    return parsed ? [parsed] : [];
  });
  const alternate = links.find(l => l.rel === undefined || l.rel === 'alternate');
  const feed: Feed = {
    format: 'atom',
    title: text(channel.title),
    authors: list(channel.author).flatMap(entry => {
      const parsed = person(entry);
      return parsed ? [parsed] : [];
    }),
    links: links.filter(l => l !== alternate),
    extensions: extensions(channel),
    namespaces: namespaces(root),
    items: entries.map(entry => atomItem(node(entry))),
  };
  const id = optional(text(channel.id));
  const description = optional(text(channel.subtitle));
  const language = optional(text(channel['@xml:lang']));
  const copyright = optional(text(channel.rights));
  const generator = optional(text(channel.generator));
  const image = optional(text(channel.logo)) ?? optional(text(channel.icon));
  const updated = date(channel.updated);
  if (id) feed.id = id;
  if (description) feed.description = description;
  if (alternate) feed.link = alternate.href;
  if (language) feed.language = language;
  if (copyright) feed.copyright = copyright;
  if (generator) feed.generator = generator;
  if (image) feed.image = image;
  if (updated) feed.updated = updated;
  return feed;
}

function byteLength(xml: string, max: number): number {
  // Every UTF-16 unit is at least one byte and at most three, so only the middle band needs real counting.
  if (xml.length > max) return xml.length;
  if (xml.length * 3 <= max) return xml.length * 3;
  return new TextEncoder().encode(xml).byteLength;
}

/**
 * Parse an RSS 2.0 or Atom 1.0 document into a {@link Feed}.
 *
 * Returns a failure for text from outside, never throws: `content.feed_too_large`,
 * `content.feed_malformed` (not well-formed XML or not a feed), `content.feed_unsupported`
 * (DOCTYPE or entity declarations), `content.feed_limit_exceeded` (too many items).
 */
export function parseFeed(
  xml: string,
  options: ParseFeedOptions = {},
): Feed | ReturnType<typeof FeedTooLarge | typeof FeedMalformed | typeof FeedUnsupported | typeof FeedLimitExceeded> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  if (byteLength(xml, maxBytes) > maxBytes) return FeedTooLarge();
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return FeedUnsupported();
  if (XMLValidator.validate(xml) !== true) return FeedMalformed();
  const document = node(xmlParser.parse(xml));
  if (document.rss !== undefined) {
    const root = node(document.rss);
    const channel = node(root.channel);
    if (Object.keys(channel).length === 0) return FeedMalformed();
    if (list(channel.item).length > maxItems) return FeedLimitExceeded();
    return rssFeed(root, channel);
  }
  if (document.feed !== undefined) {
    const root = node(document.feed);
    if (list(root.entry).length > maxItems) return FeedLimitExceeded();
    return atomFeed(root, root);
  }
  return FeedMalformed();
}
