---
'@arki/content-build': minor
---

Add `compileMarkdown` to `@arki/content-build/config`: compiles plain GitHub markdown (not MDX) to HTML with GFM, GitHub heading ids, autolinked headings and highlighted code, and returns the headings for a table of contents. A `rewriteLink` option rewrites, drops or keeps each link.
