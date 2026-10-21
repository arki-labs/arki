# @arki/string

String manipulation utilities — case conversion, base64 encoding, character counting, and template builders.

## Installation

```sh
npm install @arki/string
# or
bun add @arki/string
# or
pnpm add @arki/string
```

## Usage

### Base64 encode / decode

```ts
import { base64 } from '@arki/string/base64';

const encoded = base64.encode('hello');
const decoded = base64.decode(encoded);

// URL-safe variant (RFC 4648)
const urlEncoded = base64.urlEncode('hello?world=1');
const urlDecoded = base64.urlDecode(urlEncoded);
```

### Character counting

```ts
import { countCharacters } from '@arki/string/count-characters';

countCharacters('hello'); // 5
countCharacters();        // 0
```

### Case conversion and other utilities

```ts
import { camelCase, snakeCase, pascalCase } from '@arki/string/utils';
```

Re-exports the case-conversion helpers from `@poppinss/utils/string`.

### Template builder

```ts
import { StringBuilder } from '@arki/string/builder';
```

Re-exports the string-template builder from `@poppinss/utils/string_builder`.

### Root entry

The root entry re-exports everything for convenience:

```ts
import { base64, countCharacters, camelCase } from '@arki/string';
```

## Documentation

`@arki/string` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT. See [LICENSE](./LICENSE).
