/**
 * SEO and Metadata Components for TanStack Start
 *
 * Provides components for managing document head, meta tags, and SEO.
 */

import React from 'react';

export interface MetaProps {
  /**
   * Page title
   */
  title?: string;

  /**
   * Title template (e.g., "%s | My App")
   */
  titleTemplate?: string;

  /**
   * Page description
   */
  description?: string;

  /**
   * Canonical URL
   */
  canonical?: string;

  /**
   * Open Graph metadata
   */
  openGraph?: {
    title?: string;
    description?: string;
    type?: 'website' | 'article' | 'product';
    url?: string;
    siteName?: string;
    images?: Array<{
      url: string;
      width?: number;
      height?: number;
      alt?: string;
    }>;
    locale?: string;
    publishedTime?: string;
    authors?: string[];
  };

  /**
   * Twitter Card metadata
   */
  twitter?: {
    card?: 'summary' | 'summary_large_image' | 'player';
    site?: string;
    creator?: string;
    title?: string;
    description?: string;
    image?: string;
  };

  /**
   * Additional meta tags
   */
  additionalMetaTags?: Array<{
    name?: string;
    property?: string;
    content: string;
  }>;

  /**
   * Additional link tags
   */
  additionalLinkTags?: Array<{
    rel: string;
    href: string;
    sizes?: string;
    type?: string;
  }>;

  /**
   * Robots meta tag
   */
  robots?: {
    index?: boolean;
    follow?: boolean;
    noarchive?: boolean;
    nosnippet?: boolean;
    noimageindex?: boolean;
  };
}

/**
 * Generates meta tags for the document head
 *
 * @example
 * ```tsx
 * // In your route component
 * export const Route = createFileRoute('/')({
 *   head: () => ({
 *     meta: Meta({
 *       title: 'Home',
 *       description: 'Welcome to our app',
 *       openGraph: {
 *         title: 'Home | My App',
 *         type: 'website',
 *       },
 *     }),
 *   }),
 * });
 * ```
 */
export function Meta(props: MetaProps): Array<{ name?: string; property?: string; content: string }> {
  const tags: Array<{ name?: string; property?: string; content: string }> = [];

  // Title
  if (props.title) {
    const title = props.titleTemplate ? props.titleTemplate.replace('%s', props.title) : props.title;
    tags.push({ name: 'title', content: title });
  }

  // Description
  if (props.description) {
    tags.push({ name: 'description', content: props.description });
  }

  // Robots
  if (props.robots) {
    const robotsContent = [
      props.robots.index === false ? 'noindex' : 'index',
      props.robots.follow === false ? 'nofollow' : 'follow',
      props.robots.noarchive ? 'noarchive' : null,
      props.robots.nosnippet ? 'nosnippet' : null,
      props.robots.noimageindex ? 'noimageindex' : null,
    ]
      .filter(Boolean)
      .join(', ');
    tags.push({ name: 'robots', content: robotsContent });
  }

  // Open Graph
  if (props.openGraph) {
    const og = props.openGraph;
    if (og.title) tags.push({ property: 'og:title', content: og.title });
    if (og.description) tags.push({ property: 'og:description', content: og.description });
    if (og.type) tags.push({ property: 'og:type', content: og.type });
    if (og.url) tags.push({ property: 'og:url', content: og.url });
    if (og.siteName) tags.push({ property: 'og:site_name', content: og.siteName });
    if (og.locale) tags.push({ property: 'og:locale', content: og.locale });
    if (og.publishedTime) tags.push({ property: 'article:published_time', content: og.publishedTime });
    og.authors?.forEach(author => {
      tags.push({ property: 'article:author', content: author });
    });
    og.images?.forEach(image => {
      tags.push({ property: 'og:image', content: image.url });
      if (image.width) tags.push({ property: 'og:image:width', content: String(image.width) });
      if (image.height) tags.push({ property: 'og:image:height', content: String(image.height) });
      if (image.alt) tags.push({ property: 'og:image:alt', content: image.alt });
    });
  }

  // Twitter
  if (props.twitter) {
    const tw = props.twitter;
    if (tw.card) tags.push({ name: 'twitter:card', content: tw.card });
    if (tw.site) tags.push({ name: 'twitter:site', content: tw.site });
    if (tw.creator) tags.push({ name: 'twitter:creator', content: tw.creator });
    if (tw.title) tags.push({ name: 'twitter:title', content: tw.title });
    if (tw.description) tags.push({ name: 'twitter:description', content: tw.description });
    if (tw.image) tags.push({ name: 'twitter:image', content: tw.image });
  }

  // Additional meta tags
  props.additionalMetaTags?.forEach(tag => {
    tags.push(tag);
  });

  return tags;
}

export interface HeadProps {
  /**
   * Page title
   */
  title?: string;

  /**
   * Meta tags from Meta() function
   */
  meta?: ReturnType<typeof Meta>;

  /**
   * Children elements for the head
   */
  children?: React.ReactNode;
}

/**
 * Head component for document head management
 * Use with TanStack Start's built-in head support
 */
export function Head(props: HeadProps): React.ReactElement {
  const { title, meta = [], children } = props;

  return React.createElement(
    React.Fragment,
    null,
    title && React.createElement('title', null, title),
    meta.map((tag, index) =>
      React.createElement('meta', {
        key: `meta-${index}`,
        ...tag,
      }),
    ),
    children,
  );
}

export interface ScriptsProps {
  /**
   * Defer script loading
   * @default true
   */
  defer?: boolean;

  /**
   * Async script loading
   * @default false
   */
  async?: boolean;
}

/**
 * Scripts component placeholder
 * TanStack Start handles script injection automatically
 */
export function Scripts(_props: ScriptsProps): null {
  // TanStack Start handles script injection automatically
  return null;
}
