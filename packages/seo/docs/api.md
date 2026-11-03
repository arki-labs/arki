# @arki/seo API reference

Every exported value, grouped by import path. Types are not listed.

## @arki/seo

- `createToolMetadata`: creates consistent metadata for a tool page: title, description, canonical URL, OpenGraph and Twitter card.
- `generateLlmsTxt`: builds the content of an `llms.txt` file as a markdown string.
- `generateLlmsFullTxt`: builds the longer `llms-full.txt` with extra detail sections.
- `renderRobotsTxt`: builds the body of a `robots.txt` file.
- `robotsTxtResponse`: builds a complete `Response` for a `/robots.txt` route (plain text, one day cache by default).
- `renderUrlset`: renders a sitemap urlset XML body. A date that is invalid is listed without `lastmod`.
- `renderSitemapIndex`: renders a sitemap index XML body that points at sharded sitemaps. Use it when one sitemap would pass the 50,000 URL limit.
- `sitemapResponse`: builds a complete `Response` for a `/sitemap.xml` route (XML, one hour cache by default).
- `sitemapIndexResponse`: builds a complete `Response` for a sitemap index that points at shard sitemaps.

## @arki/seo/react

JSON-LD schema components:

- `JsonLdScript`: renders JSON-LD data as an inline script element. It escapes `<` so the data cannot close the tag.
- `ArticleSchema`: Article schema for blog posts and content pages.
- `BreadcrumbSchema`: BreadcrumbList schema for navigation trails.
- `FAQSchema`: FAQPage schema for FAQ sections.
- `HowToSchema`: HowTo schema for step by step guides.
- `ItemListSchema`: ItemList schema for category pages that list many items.
- `OrganizationSchema`: Organization schema for the homepage.
- `SoftwareApplicationSchema`: SoftwareApplication schema for web based tools and apps.
- `TechArticleSchema`: TechArticle schema (a kind of Article) for educational variant guide pages.
- `WebSiteSchema`: WebSite schema with an optional SearchAction for the sitelinks search box.

Content components:

- `FAQSection`: FAQ accordion with optional schema.org markup.
- `FAQCompact`: compact FAQ list using native details and summary elements, for sidebars.
- `FAQVisible`: server rendered FAQ with every answer visible in static HTML.
- `RelatedItems`: grid of related items for internal linking, with optional schema.org markup.
- `RelatedItemsCompact`: compact inline list of related items for a sidebar or footer.
- `ActionableInsights`: server rendered section with a heading, intro and a list of recommended next steps.
- `DeepDiveShowcase`: server rendered case studies with multi step walkthroughs.
- `EducationalContent`: server rendered educational sections in semantic HTML, by section type.
- `ExampleShowcase`: server rendered worked examples with scenario, explanation and takeaway.
- `ToolSEOContent`: composite server component that assembles all the SEO sections below a tool page.

## @arki/seo/tanstack-start

- `Head`: head component for document head management with TanStack Start head support.
- `Meta`: generates meta tags for the document head.
- `Scripts`: placeholder scripts component. TanStack Start handles script injection itself.
