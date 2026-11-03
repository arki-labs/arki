import type { Feed, FeedExtensions, FeedItem, FeedLink, FeedPerson } from './types.js';

export type GenerateFeedOptions = {
  /** Pretty-print with two-space indentation. Default true. */
  indent?: boolean;
}

type XmlElement = {
  name: string;
  attributes?: Record<string, string | undefined>;
  /** Text, child elements, or nothing (self-closing). */
  children?: string | XmlElement[];
}

const KNOWN_NAMESPACES: Record<string, string> = {
  atom: 'http://www.w3.org/2005/Atom',
  content: 'http://purl.org/rss/1.0/modules/content/',
  dc: 'http://purl.org/dc/elements/1.1/',
  itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
};

// XML 1.0 forbids most control characters even when escaped, so they are dropped.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\v\f\u000E-\u001F￾￿]/g;

function escapeText(value: string): string {
  return value
    .replaceAll(INVALID_XML_CHARS, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('\n', '&#10;');
}

function render(element: XmlElement, indent: boolean, depth: number): string {
  const pad = indent ? '  '.repeat(depth) : '';
  const newline = indent ? '\n' : '';
  const attributes = Object.entries(element.attributes ?? {})
    .flatMap(([name, value]) => (value === undefined ? [] : [` ${name}="${escapeAttribute(value)}"`]))
    .join('');
  const children = element.children;
  if (children === undefined) return `${pad}<${element.name}${attributes}/>`;
  if (typeof children === 'string') {
    return `${pad}<${element.name}${attributes}>${escapeText(children)}</${element.name}>`;
  }
  if (children.length === 0) return `${pad}<${element.name}${attributes}/>`;
  const inner = children.map(child => render(child, indent, depth + 1)).join(newline);
  return `${pad}<${element.name}${attributes}>${newline}${inner}${newline}${pad}</${element.name}>`;
}

function document(root: XmlElement, indent: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${indent ? '\n' : ''}${render(root, indent, 0)}`;
}

const text = (name: string, value: string | undefined): XmlElement[] =>
  value === undefined ? [] : [{ name, children: value }];

function extensionElements(extensions: FeedExtensions): XmlElement[] {
  return Object.entries(extensions).flatMap(([name, entries]) =>
    entries.map(
      (entry): XmlElement => ({
        name,
        attributes: entry.attributes,
        ...(entry.text === '' ? {} : { children: entry.text }),
      }),
    ),
  );
}

function namespaceAttributes(feed: Feed, needed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const prefixes = new Set(needed);
  for (const name of [...Object.keys(feed.extensions), ...feed.items.flatMap(item => Object.keys(item.extensions))]) {
    const prefix = name.split(':')[0];
    if (name.includes(':') && prefix) prefixes.add(prefix);
  }
  for (const prefix of prefixes) {
    const uri = feed.namespaces[prefix] ?? KNOWN_NAMESPACES[prefix];
    if (uri) result[`xmlns:${prefix}`] = uri;
  }
  return result;
}

/**
 * A date written with `format`, or `undefined` for an Invalid Date (a bad parse upstream).
 * `toISOString()` throws on an Invalid Date, which would fail the whole feed for one entry.
 */
const moment = (value: Date | undefined, format: (date: Date) => string): string | undefined =>
  value !== undefined && Number.isFinite(value.getTime()) ? format(value) : undefined;
const rfc822 = (date: Date): string => date.toUTCString();
const iso = (date: Date): string => date.toISOString();

function rssItem(item: FeedItem): XmlElement {
  const permalink = item.id !== undefined && item.id === item.link;
  return {
    name: 'item',
    children: [
      ...text('title', item.title),
      ...text('link', item.link),
      ...(item.id === undefined
        ? []
        : [{ name: 'guid', attributes: { isPermaLink: String(permalink) }, children: item.id }]),
      ...text('description', item.summary),
      ...text('content:encoded', item.content),
      ...text('pubDate', moment(item.published, rfc822)),
      ...item.authors.flatMap(author => text('dc:creator', author.name)),
      ...item.categories.flatMap(category => text('category', category)),
      ...item.links
        .filter(l => l.rel === 'enclosure')
        .map(
          (l): XmlElement => ({
            name: 'enclosure',
            attributes: { url: l.href, length: String(l.length ?? 0), type: l.type },
          }),
        ),
      ...extensionElements(item.extensions),
    ],
  };
}

/** Write a feed as RSS 2.0. Text is escaped; control characters XML forbids are dropped. */
export function generateRss(feed: Feed, options: GenerateFeedOptions = {}): string {
  const needsContent = feed.items.some(item => item.content !== undefined);
  const needsDc = feed.items.some(item => item.authors.length > 0);
  const self = feed.links.find(l => l.rel === 'self');
  const needed = [...(needsContent ? ['content'] : []), ...(needsDc ? ['dc'] : []), ...(self ? ['atom'] : [])];
  const channel: XmlElement = {
    name: 'channel',
    children: [
      ...text('title', feed.title),
      ...text('description', feed.description ?? ''),
      ...text('link', feed.link),
      ...(self
        ? [{ name: 'atom:link', attributes: { href: self.href, rel: 'self', type: 'application/rss+xml' } }]
        : []),
      ...text('language', feed.language),
      ...text('copyright', feed.copyright),
      ...text('managingEditor', feed.managingEditor),
      ...text('webMaster', feed.webMaster),
      ...text('lastBuildDate', moment(feed.updated, rfc822)),
      ...text('generator', feed.generator),
      ...(feed.ttl === undefined ? [] : text('ttl', String(feed.ttl))),
      ...(feed.image
        ? [
            {
              name: 'image',
              children: [...text('url', feed.image), ...text('title', feed.title), ...text('link', feed.link)],
            },
          ]
        : []),
      ...extensionElements(feed.extensions),
      ...feed.items.map(item => rssItem(item)),
    ],
  };
  const root: XmlElement = {
    name: 'rss',
    attributes: { version: '2.0', ...namespaceAttributes(feed, needed) },
    children: [channel],
  };
  return document(root, options.indent ?? true);
}

const person = (name: string, value: FeedPerson): XmlElement => ({
  name,
  children: [...text('name', value.name), ...text('email', value.email), ...text('uri', value.url)],
});

const atomLink = (value: FeedLink): XmlElement => ({
  name: 'link',
  attributes: {
    href: value.href,
    rel: value.rel,
    type: value.type,
    length: value.length === undefined ? undefined : String(value.length),
  },
});

function latest(feed: Feed): Date {
  const times = feed.items
    .flatMap(item => [item.updated, item.published])
    .flatMap(d => (d !== undefined && Number.isFinite(d.getTime()) ? [d.getTime()] : []));
  return new Date(times.length > 0 ? Math.max(...times) : 0);
}

function atomEntry(item: FeedItem): XmlElement {
  const id = item.id ?? item.link ?? item.title;
  // `updated` is required in Atom: a bad date falls back to the next one, then to the epoch.
  const updated = moment(item.updated, iso) ?? moment(item.published, iso) ?? iso(new Date(0));
  return {
    name: 'entry',
    children: [
      ...text('id', id),
      ...text('title', item.title),
      ...(item.link ? [atomLink({ href: item.link, rel: 'alternate' })] : []),
      ...item.links.map(l => atomLink(l)),
      ...text('updated', updated),
      ...text('published', moment(item.published, iso)),
      ...item.authors.map(author => person('author', author)),
      ...item.categories.map((term): XmlElement => ({ name: 'category', attributes: { term } })),
      ...text('summary', item.summary),
      ...(item.content === undefined
        ? []
        : [{ name: 'content', attributes: { type: 'html' }, children: item.content }]),
      ...extensionElements(item.extensions),
    ],
  };
}

/** Write a feed as Atom 1.0. Text is escaped; control characters XML forbids are dropped. */
export function generateAtom(feed: Feed, options: GenerateFeedOptions = {}): string {
  const root: XmlElement = {
    name: 'feed',
    attributes: {
      xmlns: 'http://www.w3.org/2005/Atom',
      'xml:lang': feed.language,
      ...namespaceAttributes(feed, []),
    },
    children: [
      ...text('id', feed.id ?? feed.link ?? feed.title),
      ...text('title', feed.title),
      ...text('subtitle', feed.description),
      ...text('updated', moment(feed.updated, iso) ?? iso(latest(feed))),
      ...(feed.link ? [atomLink({ href: feed.link, rel: 'alternate' })] : []),
      ...feed.links.map(l => atomLink(l)),
      ...feed.authors.map(author => person('author', author)),
      ...text('rights', feed.copyright),
      ...text('generator', feed.generator),
      ...text('logo', feed.image),
      ...extensionElements(feed.extensions),
      ...feed.items.map(item => atomEntry(item)),
    ],
  };
  return document(root, options.indent ?? true);
}

/** Write a feed in the given format. */
export function generateFeed(feed: Feed, format: 'rss' | 'atom', options: GenerateFeedOptions = {}): string {
  return format === 'rss' ? generateRss(feed, options) : generateAtom(feed, options);
}
