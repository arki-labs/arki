# @arki/design-systems for agents

Read this before touching tokens or choosing a system for an app. The [README](../README.md) is the overview.

## The model

- A **design system** is a folder of three CSS files (tokens, Tailwind bridge, fonts) and a small TypeScript module with font variable names.
- The **tokens** are CSS custom properties with the same names in every system, such as `--primary` and `--muted-foreground`. Light values sit on `:root`, dark values on `.dark`.
- The **bridge** maps each token to a Tailwind colour (`--color-primary: var(--primary)`), so `bg-primary` works.
- The **registry** lists the supported ids and looks one up.
- An app picks one system and keeps it.

```text
tokens.css  ->  theme-bridge.css  ->  Tailwind classes (bg-primary)  ->  @arki/ui components
```

## Task map

### Use a system in an app

Import in this order, after Tailwind:

```css
@import 'tailwindcss';
@import '@arki/design-systems/workbench/fonts.css';
@import '@arki/design-systems/workbench/tokens.css';
@import '@arki/design-systems/workbench/theme-bridge.css';
```

### Read a font variable name in TypeScript

```ts
import { mono, sans, serif } from '@arki/design-systems/atelier/fonts';

export const fontVariables = [sans.variable, mono.variable, serif.variable];
```

### Check an id that came from outside

```ts
import { resolveDesignSystemId } from '@arki/design-systems/registry';

export function systemFor(input: unknown) {
  return resolveDesignSystemId(input, 'workbench');
}
```

### Add a token

Add it to `tokens.css` (light and `.dark`) and `theme-bridge.css` in every system. Confirm with the founder first: this changes the shared contract.

### Add an app-specific token

Define it in the app's own CSS under a new name, for example `--brand-ribbon`. Do not redefine a shared name.

## Rules that bite

- Never mix two systems in one app.
- `tokens.css` does nothing without `theme-bridge.css`.
- `parseDesignSystemId` throws. `resolveDesignSystemId` returns a fallback. `getDesignSystemByIdSafe` returns `null`.
- `gallery` has CSS but is not in the registry.
- Dark mode needs the `dark` class on `<html>`. `@arki/theme` sets it.

## Errors

This package defines no error codes. `parseDesignSystemId` throws a `ZodError`.

## Verify

```sh
bun run typecheck && bun run lint && bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
