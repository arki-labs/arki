# @arki/ui for agents

Read this before adding or changing a component. The [README](../README.md) is the overview.

## The model

- A component is a styled wrapper over a Base UI primitive. It takes the primitive's props and adds classes.
- Colours come from semantic tokens that `@arki/design-systems` defines. The same component works in `atelier`, `workbench` and `arena`.
- Tailwind generates the CSS in the app, not in this package. The app must scan `@arki/ui/src` with `@source`.
- Every component is its own subpath. There is no root import.

```text
@arki/design-systems tokens  ->  Tailwind classes  ->  @arki/ui component  ->  app
```

## Task map

### Show a card with a button

```tsx
import { Button } from '@arki/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@arki/ui/card';

export function Welcome() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome</CardTitle>
      </CardHeader>
      <CardContent>
        <Button variant="outline" size="sm">
          Get started
        </Button>
      </CardContent>
    </Card>
  );
}
```

### Open a dialog from a button

```tsx
import { Button } from '@arki/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@arki/ui/dialog';

export function DeleteDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive">Delete</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this item?</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
```

### Show a toast

Mount `Toaster` once near the root. Call `toast` from anywhere.

```tsx
import { Button } from '@arki/ui/button';
import { toast, Toaster } from '@arki/ui/sonner';

export function Saved() {
  return (
    <>
      <Button onClick={() => toast('Saved')}>Save</Button>
      <Toaster />
    </>
  );
}
```

### Merge class names

```ts run expect
import { cn } from '@arki/ui/cn';

console.log(cn('px-2 py-1', 'px-4'));
```

```text
py-1 px-4
```

### Add a component

Create `src/<name>.tsx` with a one-line summary comment first. Wrap a Base UI primitive, use `cva` for variants, `cn` for classes and semantic tokens for colour. Add the `exports` row, regenerate `llms.txt`, add it to the README table. Check it in atelier, workbench and arena.

## Rules that bite

- There is no root import. `import { Button } from '@arki/ui'` fails.
- If components look unstyled, the app's `@source` line is missing or wrong.
- Never mix two design systems in one app.
- `katex` needs `katex/dist/katex.min.css` loaded by the app.
- `useFormField`, `useSidebar` and the other compound hooks throw outside their parent.
- Use semantic tokens only. A raw colour breaks in another system.

## Errors

This package defines no error codes. The compound hooks throw a plain `Error` whose message names the missing parent.

## Verify

```sh
bun run typecheck && bun run lint && bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
