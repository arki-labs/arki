/**
 * Shared prop types for SEO structured data components.
 *
 * These types define the inputs that each JSON-LD schema component accepts.
 * Components use explicit props rather than importing app config directly,
 * making them reusable across all apps in the monorepo.
 */

/** Common site identity props required by Organization and WebSite schemas */
export type SiteIdentityProps = {
  siteName: string;
  siteUrl: string;
  siteDescription: string;
};

/** Props for OrganizationSchema */
export type OrganizationSchemaProps = SiteIdentityProps & {
  authorName: string;
  /** Path to logo relative to siteUrl. Defaults to '/icon.png' */
  logoPath?: string;
  /** Social media profile URLs for sameAs property */
  sameAs?: string[];
};

/** Props for WebSiteSchema */
export type WebSiteSchemaProps = SiteIdentityProps & {
  /** URL template for sitelinks search box, e.g. '/search?q={search_term_string}' */
  searchUrlTemplate?: string;
};

export type BreadcrumbItem = {
  href: string;
  label: string;
};

/** Props for BreadcrumbSchema */
export type BreadcrumbSchemaProps = {
  items: BreadcrumbItem[];
  siteUrl: string;
};

export type FAQItem = {
  question: string;
  answer: string;
  /** ISO YYYY-MM-DD when the FAQ first appeared. Optional; emitted into FAQPage JSON-LD as `datePublished` for AEO freshness signaling. */
  datePublished?: string;
  /** ISO YYYY-MM-DD of the most recent meaningful edit. Optional; emitted into FAQPage JSON-LD as `dateModified`. */
  dateModified?: string;
};

/** Props for FAQSchema */
export type FAQSchemaProps = {
  faqs: FAQItem[];
};

export type ArticleData = {
  title: string;
  description: string;
  url: string;
  publishedAt: Date | string;
  modifiedAt?: Date | string;
  author: {
    name: string;
    url?: string;
  };
  image?: string;
};

/** Props for ArticleSchema */
export type ArticleSchemaProps = {
  article: ArticleData;
  siteName: string;
  siteUrl: string;
};

export type HowToStep = {
  name: string;
  text: string;
  image?: string;
};

/** Props for HowToSchema */
export type HowToSchemaProps = {
  name: string;
  description: string;
  steps: HowToStep[];
  /** ISO 8601 duration format, e.g., "PT5M" for 5 minutes */
  totalTime?: string;
};

export type ItemListItem = {
  name: string;
  url: string;
  description?: string;
};

/** Props for ItemListSchema */
export type ItemListSchemaProps = {
  name: string;
  description: string;
  items: ItemListItem[];
  id: string;
  siteUrl: string;
};

/** Props for SoftwareApplicationSchema */
export type SoftwareApplicationSchemaProps = {
  name: string;
  description: string;
  url: string;
  category: string;
  keywords?: string[];
  id: string;
  siteName: string;
  siteUrl: string;
};

/** Item shape for RelatedItems component */
export type RelatedItem = {
  key: string;
  title: string;
  description: string;
};

/** Props for FAQSection component */
export type FAQSectionProps = {
  title?: string;
  description?: string;
  faqs: FAQItem[];
  className?: string;
  /** Whether to include the FAQ schema for SEO */
  includeSchema?: boolean;
};

/** Item for llms.txt generation */
export type LlmsTxtItem = {
  title: string;
  url: string;
  description: string;
};

/** Section grouping for llms.txt */
export type LlmsTxtSection = {
  heading: string;
  items: LlmsTxtItem[];
};

/** Input for llms.txt generation */
export type LlmsTxtInput = {
  name: string;
  tagline: string;
  description: string;
  sections: LlmsTxtSection[];
};

/** Input for llms-full.txt generation (extended version) */
export type LlmsFullTxtInput = LlmsTxtInput & {
  details: Record<string, string>;
};

// ---------------------------------------------------------------------------
// SEO Content Components
// ---------------------------------------------------------------------------

/** A structured educational section with type-specific rendering.
 *
 * Supported types:
 * - `text` — heading + paragraph (items ignored)
 * - `list` — heading + paragraph + unordered list (`items: string[]`)
 * - `comparison` — heading + paragraph + description list (`items: Record<string, string>`)
 * - `table` — heading + paragraph + data table (`items: Record<string, string>`)
 * - `callout` — highlighted box with icon for key facts (`variant`: info/warning/tip)
 * - `steps` — numbered step-by-step instructions (`items: string[]`)
 * - `formula` — math formula display with explanation (`formula: string` for KaTeX/plain text)
 * - `stat-highlight` — large-number callout cards (`items: Record<string, string>` label → value)
 */
export type EducationalSection = {
  /** Section heading */
  heading: string;
  /** Introductory paragraph */
  content: string;
  /** Determines the rendering strategy for supplementary items */
  type: 'text' | 'list' | 'comparison' | 'table' | 'callout' | 'steps' | 'formula' | 'stat-highlight';
  /** Items to render below the content paragraph. Shape depends on `type`:
   * - `list` / `steps`: `string[]`
   * - `comparison` / `table` / `stat-highlight`: `Record<string, string>` (key → value)
   * - `text` / `callout` / `formula`: ignored
   */
  items?: string[] | Record<string, string>;
  /** Callout variant — only used when `type` is `callout` */
  variant?: 'info' | 'warning' | 'tip';
  /** Math formula string — only used when `type` is `formula`.
   *  Rendered as-is in a styled block (KaTeX rendering can be added later). */
  formula?: string;
};

/** A worked example with scenario, explanation, and key takeaway */
export type ExampleItem = {
  /** Example title */
  heading: string;
  /** The scenario or setup */
  scenario: string;
  /** Explanation of the calculation or process */
  explanation: string;
  /** Key insight the reader should take away */
  takeaway: string;
  /** Optional input values for "try this example" interactivity.
   *  When provided alongside `renderExampleAction` in ExampleShowcase,
   *  enables users to pre-fill a calculator with these values. */
  inputs?: Record<string, unknown>;
};

/** Data for an actionable insights section */
export type ActionableInsightsData = {
  /** Section heading */
  heading: string;
  /** Introductory paragraph */
  content: string;
  /** List of recommended action items */
  actionItems: string[];
};

/** Props for the FAQVisible server component */
export type FAQVisibleProps = {
  title?: string;
  description?: string;
  faqs: FAQItem[];
  className?: string;
  includeSchema?: boolean;
};

// ---------------------------------------------------------------------------
// Deep Documentation Types (for variant-first documentation strategy)
// ---------------------------------------------------------------------------

/**
 * A single calculation step within a deep-dive example.
 *
 * Each step shows a label (what's being calculated) and a value (the result),
 * enabling multi-step calculation walkthroughs.
 */
export type CalculationStep = {
  /** What is being calculated */
  label: string;
  /** The computed value or expression */
  value: string;
};

/**
 * Rich use-case example with multi-step calculations and decision guidance.
 *
 * Extends beyond `ExampleItem`'s single-paragraph explanation to include
 * industry context, step-by-step calculations, before/after comparisons,
 * and actionable decision guidance.
 *
 * @example
 * ```ts
 * const deepDive: DeepDiveExample = {
 *   title: "Pouring a 20x20 ft Patio",
 *   industry: "home improvement",
 *   scenario: "A homeowner planning a backyard patio needs to estimate concrete volume.",
 *   calculationSteps: [
 *     { label: "Area", value: "20 × 20 = 400 sq ft" },
 *     { label: "Volume", value: "400 × (4/12) = 133.3 cu ft" },
 *     { label: "Cubic yards", value: "133.3 / 27 = 4.94 cu yd" },
 *     { label: "With 10% waste", value: "4.94 × 1.1 = 5.4 cu yd" },
 *   ],
 *   comparison: { before: '4" thick: 4.94 cu yd', after: '6" thick: 7.41 cu yd' },
 *   decisionGuidance: "For a patio with no vehicle traffic, 4 inches is standard.",
 * };
 * ```
 */
export type DeepDiveExample = {
  /** Example title */
  title: string;
  /** Industry or domain context (e.g., "construction", "sports", "cooking") */
  industry?: string;
  /** The scenario setup — who is doing what and why */
  scenario: string;
  /** Step-by-step calculation walkthrough */
  calculationSteps: CalculationStep[];
  /** Optional before/after comparison */
  comparison?: { before: string; after: string };
  /** Practical decision guidance based on the results */
  decisionGuidance: string;
};

/**
 * Article metadata for TechArticle JSON-LD emission.
 *
 * When present on a variant, the variant page emits a TechArticle schema —
 * signaling to Google that the page is both a tool AND an educational
 * article, opening rich result opportunities.
 */
export type ArticleMetaData = {
  /** ISO 8601 date string when the article was first published */
  datePublished: string;
  /** ISO 8601 date string when the article was last modified */
  dateModified?: string;
};

/** Props for TechArticleSchema */
export type TechArticleSchemaProps = {
  /** Guide title used as the article headline */
  title: string;
  /** Guide summary used as article description */
  description: string;
  /** Full canonical URL of the variant page */
  url: string;
  /** Article publication and modification dates */
  articleMeta: ArticleMetaData;
  /** Site identity for publisher information */
  siteName: string;
  /** Site URL for publisher information */
  siteUrl: string;
  /** Author name */
  authorName: string;
};
