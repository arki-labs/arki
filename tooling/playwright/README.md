# @arki/playwright-config

The Playwright config ARKI projects share. It ships TypeScript source, which Playwright loads directly. There is no build.

## Install

```sh
bun add -D @arki/playwright-config @playwright/test
```

## Use

```ts
import { createPlaywrightConfig } from '@arki/playwright-config';

export default createPlaywrightConfig({
  baseURL: 'http://localhost:4000',
  webServerCommand: 'bun run dev',
});
```

`createPlaywrightConfig` takes these options, all optional: `testDir` (`./e2e`), `baseURL` (`http://localhost:3000`), `webServerCommand` (`bun run dev`), `webServerUrl`, `webServerTimeout`, `extraProjects`, `use`, `overrides` and `extraWebServers`. It runs Chromium by default, retries twice on CI, and keeps a trace on the first retry.

`e2ePolicy` is a ready set of run settings (parallel, four workers, `list` and `html` reporters) for suites that run against a real stack.

## Limits

- One default browser project: Chromium. Add more with `extraProjects`.
- The default dev server command is `bun run dev`. Change `webServerCommand` if you do not use Bun.

## Support

Issues and source: [arki-labs/arki](https://github.com/arki-labs/arki/tree/main/tooling/playwright).
