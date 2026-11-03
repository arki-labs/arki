---
'@arki/tanstack-start': patch
---

`fleetVite()` bundles every `@arki/*` package into the SSR build.

`@arki/ui` and `@arki/icons` publish TypeScript source as their `import` target, and `@arki/seo/react` imports `@arki/icons/phosphor`. Left external, the SSR output imports them from `node_modules`, where Node refuses to strip types (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so Nitro's prerender of `/robots.txt` and `/sitemap.xml` answered 500. The rule is merged with the app's own `ssr.noExternal` list.
