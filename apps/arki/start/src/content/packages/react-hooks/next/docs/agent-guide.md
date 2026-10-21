# @arki/react-hooks for agents

Read this before adding or changing a hook. The [README](../README.md) is the overview.

## The model

- Each hook lives behind its own subpath, for example `@arki/react-hooks/debounce`. There is no root import.
- Most files re-export a hook from `@mantine/hooks`, `usehooks-ts`, `react-hotkeys-hook` or `@rehooks/local-storage`. The rest (`async-memo`, `is-client`, `long-press`, `touch`, `use-viewport`, `use-swipe-gesture`, `use-touch-feedback`, the `useIs*` hooks) are written here.
- Every hook is safe to render on the server. Browser values arrive after the first effect.

## Task map

### Wait for the user to stop typing

```tsx
import { useDebouncedValue } from '@arki/react-hooks/debounce';

export function useSearchTerm(raw: string): string {
  const [term] = useDebouncedValue(raw, 250);
  return term;
}
```

### Load something async when inputs change

```tsx
import { useAsyncMemo } from '@arki/react-hooks/async-memo';

export function useUserName(id: string): string {
  return useAsyncMemo(
    async () => {
      const response = await fetch(`/api/users/${id}`);
      return response.ok ? await response.text() : 'unknown';
    },
    [id],
    'loading',
  );
}
```

### Show a different layout on phones

```tsx
import { useIsMobile } from '@arki/react-hooks/media-query';

export function Layout() {
  const isMobile = useIsMobile();
  return <main data-layout={isMobile ? 'stack' : 'columns'} />;
}
```

### Remember a value between visits

```tsx
import { useLocalStorage } from '@arki/react-hooks/local-storage';

export function useSidebarOpen() {
  return useLocalStorage<boolean>('sidebar-open', true);
}
```

### Add a new hook

Create `src/<name>.tsx` with a one-line summary comment first. Add `./<name>` to `exports` in `package.json` (copy a neighbour). Add a line to the README "Public imports". Run Verify.

## Rules that bite

- There is no root import. `import { x } from '@arki/react-hooks'` fails.
- `useAsyncMemo` does not catch a rejected promise. Catch inside the factory.
- `useViewport` (mobile under 640px) and `useIsMobile` (mobile under 768px) disagree between those widths.
- Server render gives `false` for the `useIs*` hooks. The client value arrives after the first effect.

## Errors

None. This package defines no error codes and throws nothing of its own.

## Verify

```sh
bun run typecheck && bun run lint && bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
