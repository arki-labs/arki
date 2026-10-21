import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { contentPlugin } from '@arki/content-build/vite';
import { devServer, printLocalhostUrl } from '@arki/dev-certs';
import { nitro } from 'nitro/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { createPwaPlugin } from '@fleet/tanstack-start/pwa';
import { fleetVite } from '@fleet/tanstack-start/vite';

export default defineConfig({
  server: {
    port: Number(process.env.ARKI_DEV_PORT ?? 5181),
    strictPort: true,
    ...devServer(),
  },
  resolve: {
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom'],
  },
  envPrefix: 'VITE_',
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      // `bun` is a runtime built-in module — `@arki/db/init` resolves to
      // `init.bun.ts` under the `bun` export condition (set automatically
      // when Vite is invoked via `bun run vite build`). Rolldown can't
      // bundle it; the deploy runs on `oven/bun:1-alpine` so the import
      // works natively at runtime.
      external: ['bun'],
    },
  },
  ssr: {
    external: [
      'bun',
      // Heavy vendor deps externalized for SSR — they live in node_modules
      // which the Dockerfile copies into the runtime image, so Bun resolves
      // them natively. Inlining was bloating the SSR bundle (Phosphor alone
      // was ~6.5MB raw / 1.1MB gzip) and breaking tree-shaking via Rolldown's
      // CJS interop runtime (`__exportAll` + `__toESM(require_x())`).
      '@phosphor-icons/react',
      '@base-ui/react',
      '@daveyplate/better-auth-ui',
      '@better-auth/core',
      '@tanstack/react-router',
      'recharts',
      'mathjs',
      'framer-motion',
      'jspdf',
      'katex',
    ],
  },
  plugins: [
    printLocalhostUrl(),
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/paraglide',
      // Do NOT use 'globalVariable' on the server — Paraglide's `_locale`
      // module variable persists across requests on Bun/Node and pollutes
      // locale detection (the first request "wins" forever). URL-first
      // detection is the only safe order for SSR with the `url` strategy.
      strategy: ['url', 'cookie', 'preferredLanguage', 'baseLocale'],
      cookieName: 'arki_LOCALE',
      // To add a non-default locale (e.g. German), uncomment and adapt:
      //   urlPatterns: [{
      //     pattern: '/:path(.*)?',
      //     // Order matters: list more specific (longer-prefix) localized
      //     // patterns BEFORE the unprefixed base. Putting `en` first would
      //     // make `/:path(.*)?` greedily match `/de/...` URLs as English.
      //     // See .agents/skills/tanstack-start/i18n.md gotcha #1.
      //     localized: [
      //       ['de', '/de/:path(.*)?'],
      //       ['en', '/:path(.*)?'],
      //     ],
      //   }],
    }),
    tailwindcss(),
    contentPlugin(),
    nitro({
      // Prerender SEO discovery files and every docs page without params at
      // build time — output lives in `.output/public/` and is served by the
      // CDN edge with no function invocation per request. Detail pages
      // (`/packages/$name/...`, `/docs/guides/$slug`, `/errors/$code`) stay
      // server-rendered: they grow with every package version and doc file,
      // and their data is bundled, so rendering one on request is cheap.
      prerender: {
        routes: [
          '/robots.txt',
          '/sitemap.xml',
          '/llms.txt',
          '/llms-full.txt',
          '/.well-known/security.txt',
          '/packages',
          '/packages/index.json',
          '/errors',
          '/docs',
          '/docs/guides',
          '/docs/glossary',
          '/docs/dot-new',
          '/docs/upgrade-story',
          '/compare',
          '/agents',
        ],
      },
    }),
    tanstackStart({
      // `entry` resolves relative to `srcDirectory` (default 'src'), not
      // the project root — './src/entry-server.ts' silently falls back to
      // TanStack's default-entry stub.
      server: { entry: './entry-server.ts' },
      router: {
        routesDirectory: 'routes',
        generatedRouteTree: 'routeTree.gen.ts',
        quoteStyle: 'single',
        semicolons: true,
      },
    }),
    createPwaPlugin(),
    fleetVite(),
    viteReact(),
  ],
});
