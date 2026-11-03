# @arki/eslint-config

Shared ESLint flat configs for ARKI projects. Plain JavaScript, no build.

## Install

```sh
bun add -D @arki/eslint-config eslint
```

## Use

Import a preset in `eslint.config.js` and spread it.

```js
import base from '@arki/eslint-config/base';
import react from '@arki/eslint-config/react';

export default [...base, ...react];
```

A cross-runtime library needs one line:

```js
export { default } from '@arki/eslint-config/library';
```

| Import                              | What it is                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@arki/eslint-config/base`          | TypeScript, import, unicorn, regexp, tsdoc and turbo rules for any package. Also exports `restrictEnvAccess`. |
| `@arki/eslint-config/library`       | `library({ adapters })`: bans Node and Bun imports and Hermes-missing array methods in `src/**`.    |
| `@arki/eslint-config/react`         | React rules for `.ts` and `.tsx` files.                                                             |
| `@arki/eslint-config/tanstack-start`| TanStack Query and Router rules. `tanstackStartDot()` adds the Dot contract rules.                  |
| `@arki/eslint-config/feature-layers`| `featureLayers({ root, ... })`: import rules between the layers of a Dot feature folder.            |

## Limits

- Flat config only. ESLint 9 or newer.
- `base` reads a `.gitignore` two folders above the package. Inside the ARKI monorepo that is the repo root. In another project, check that it finds your ignore file.
- The plugins are regular dependencies, so installing the config installs them all.

## Support

Issues and source: [arki-labs/arki](https://github.com/arki-labs/arki/tree/main/tooling/eslint).
