# @arki/prettier-config

The Prettier config ARKI projects share. Plain JavaScript, no build.

## Install

This config is not published to npm. It is used inside this repo only. A package here adds it as a workspace dependency:

```json
{ "devDependencies": { "@arki/prettier-config": "workspace:*" } }
```

## Use

In `package.json`:

```json
{
  "prettier": "@arki/prettier-config"
}
```

The config sets 120 columns, single quotes, semicolons, trailing commas and no parens around a single arrow parameter. It loads three plugins: `@ianvs/prettier-plugin-sort-imports` (import order), `prettier-plugin-tailwindcss` (class order, for `cn` and `cva` calls) and `prettier-plugin-packagejson` (key order). They install with the config.

## Limits

- `tailwindConfig` points at `../../tooling/tailwind/src/web.ts`, a path inside the ARKI monorepo. Outside it, the file does not exist. Override `tailwindConfig` in your own Prettier file if you use Tailwind.
- The import order groups know `@arki/*` and a few app scopes. Other scopes fall into third-party.

## Support

Issues and source: [arki-labs/arki](https://github.com/arki-labs/arki/tree/main/tooling/prettier).
