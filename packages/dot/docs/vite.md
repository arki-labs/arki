# The app, checked at build time (`@arki/dot/vite`)

A Dot app configures without opening anything: `configure()` builds the manifest, `boot()` opens the infra. The Vite plugin runs the first step while Vite builds, so the build tells you about a mistake that would otherwise wait for the first production request.

```ts
// apps/shop/start/vite.config.ts
import { defineConfig } from 'vite';

import { dotVite } from '@arki/dot/vite';

export default defineConfig({
  plugins: [dotVite({ app: '../backend/src/app.ts' })],
});
```

## What it does

`vite build`

- Imports the app module through Vite's module runner. Aliases, `tsconfig` paths and workspace packages resolve the way the app's own bundle resolves them.
- Finds the app export the way the `dot` CLI does: `default`, else `app`, else the one export that is a Dot app.
- Calls `configure()`. Never `boot()`: no pool, no socket, no timer.
- Fails the build when the module throws while it loads, exports no app, or does not configure. The error is the Dot failure, with its code and remediation.
- Writes `dot-manifest.json` and one `<format>.json` per registered projection (for example `openapi.json` from `@arki/http`) into the **server** output, next to the server chunk. The client output never receives them: the manifest describes the server.

`vite dev`

- Runs the same check when the server starts and after every change to a module of the app's graph.
- Reports a failure through Vite's logger as `[arki-dot] [dot.<code>] …` and keeps serving.

## Options

| Option         | Default                    | Meaning                                                                                           |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `app`          | required                   | The app module, relative to the Vite root or absolute.                                            |
| `manifestFile` | `dot-manifest.json`        | File name of the manifest in the server output. `false` writes none.                              |
| `projections`  | `true`                     | Write each registered projection as `<format>.json`. A format that cannot render fails the build. |
| `importConfig` | the root, `tsconfig` paths | Vite inline config for the import of the app module: aliases, conditions, `define`.               |

## Reading the files

`describeDotApp(appFilePath, options)` is the function behind the plugin. It returns `{ manifest, files, dependencies }` or a Dot failure, never throws, and is what a script or another plugin calls to get the same files without Vite's build.

The files are build output. Serve `openapi.json` from a route if the document is public; keep `dot-manifest.json` on the server, it lists every plugin, service and dependency edge of the app.

## Requirements

`vite` is an optional peer of `@arki/dot`; the plugin uses Vite's `runnerImport`, which needs Vite 7 or newer. The app module must be inert on import: a module that reads env or opens a connection at import time is a bug this plugin will find.
