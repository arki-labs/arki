import type { Element, ElementContent, Root } from 'hast';
import type * as unified from 'unified';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified as createProcessor } from 'unified';
import { visit } from 'unist-util-visit';

import { addGithubFlavouredMd } from '../plugins/add-github-flavoured-md.js';
import { addIdToHeadings } from '../plugins/add-id-to-headings.js';
import { autolinkHeadings } from '../plugins/autolink-headings.js';
import { prettyCode } from '../plugins/pretty-code.js';

/** One heading of the page, in document order: what an on-page table of contents lists. */
export type MarkdownHeading = { depth: number; text: string; id: string };

export type CompiledMarkdown = { html: string; headings: MarkdownHeading[] };

export type CompileMarkdownOptions = {
  /**
   * Called with the `href` of every link. Return a new `href`, `null` to drop the link and keep its text, or
   * `undefined` to keep the link as written.
   */
  rewriteLink?: (href: string) => string | null | undefined;
  /**
   * Keep raw HTML in the markdown exactly as written (scripts, event handlers and all). Default `false`: raw HTML is
   * parsed and then cleaned with `rehype-sanitize`'s GitHub-style rules, so a hostile document cannot inject script.
   * Set it only for markdown your own team wrote.
   */
  trustedHtml?: boolean;
};

const headingDepths: Readonly<Record<string, number>> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(child => textOf(child)).join('');
  return '';
}

/** Reads the headings once `rehype-slug` has given them ids, before autolinking adds anchors inside them. */
function collectHeadings(headings: MarkdownHeading[]): unified.Plugin<[], Root> {
  return () => tree => {
    visit(tree, 'element', (node: Element) => {
      const depth = headingDepths[node.tagName];
      const id = node.properties['id'];
      if (depth === undefined || typeof id !== 'string') return;
      headings.push({
        depth,
        text: node.children
          .map(child => textOf(child))
          .join('')
          .trim(),
        id,
      });
    });
  };
}

function rewriteLinks(rewriteLink: NonNullable<CompileMarkdownOptions['rewriteLink']>): unified.Plugin<[], Root> {
  return () => tree => {
    visit(tree, 'element', (node: Element, index, parent) => {
      const href = node.properties['href'];
      if (node.tagName !== 'a' || typeof href !== 'string') return;
      const next = rewriteLink(href);
      if (next === undefined) return;
      if (next !== null) {
        node.properties['href'] = next;
        return;
      }
      if (parent === undefined || index === undefined) return;
      parent.children.splice(index, 1, ...node.children);
      return index;
    });
  };
}

/**
 * Compiles plain GitHub-flavoured markdown (not MDX: `<` and `{` in prose stay text) to HTML with this package's own
 * plugins: GFM, GitHub-style heading ids, autolinked headings and code blocks highlighted by `rehype-pretty-code`
 * (light and dark themes as `--shiki-light` / `--shiki-dark` CSS variables). Raw HTML in the markdown is sanitized
 * (GitHub's rules: no `<script>`, no event handlers, no `javascript:` links) unless `trustedHtml` is set.
 */
export async function compileMarkdown(
  markdown: string,
  options: CompileMarkdownOptions = {},
): Promise<CompiledMarkdown> {
  const headings: MarkdownHeading[] = [];
  const rehypePlugins: unified.PluggableList = [
    rehypeRaw,
    // Before the plugins below, so the ids, anchors and code classes they add are not stripped.
    ...(options.trustedHtml === true ? [] : [rehypeSanitize]),
    addIdToHeadings,
    collectHeadings(headings),
    autolinkHeadings,
    prettyCode,
  ];
  if (options.rewriteLink !== undefined) rehypePlugins.push(rewriteLinks(options.rewriteLink));
  const file = await createProcessor()
    .use(remarkParse)
    .use({ plugins: [addGithubFlavouredMd] })
    .use(remarkRehype, { allowDangerousHtml: true })
    .use({ plugins: rehypePlugins })
    .use(rehypeStringify)
    .process(markdown);
  return { html: String(file), headings };
}
