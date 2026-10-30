---
'@arki/seo': patch
---

An Invalid Date no longer fails the whole sitemap or Article JSON-LD: the sitemap lists the URL without `<lastmod>`, and Article omits the bad date.
