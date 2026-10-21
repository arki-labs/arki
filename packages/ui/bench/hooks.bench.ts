// Bundle size of the same hooks from @arki/ui/hooks and from other hook libraries.
// Run: `bun run bench`.

import { defineSuite, size } from '@arki/bench';

const WRAPPED = 'closest equivalent: other options, return shape or behaviour';

export default defineSuite({
  id: '@arki/ui/hooks',
  intro:
    'Bundle size of the same hooks from @arki/ui/hooks and from the main hook libraries: usehooks-ts, @mantine/hooks, react-use and ahooks. @arki/ui/hooks re-exports hooks from @rehooks/local-storage, @mantine/hooks and usehooks-ts, so those libraries are measured directly to show the wrapper cost.',
  notes: [
    'Only the wrapped library is the same feature as the @arki hook. Every other library offers the closest equivalent with other options, return values or behaviour, so it is measured but never ranked (`differs`).',
    'react-use `useDebounce` debounces a callback inside an effect, not a value. ahooks has `useDebounce` for values but no `useMediaQuery`; `useResponsive` is the nearest.',
    '@arki/ui/hooks `useLocalStorage` is @rehooks/local-storage (synchronised across tabs and components); `useDebouncedValue`, `useMediaQuery` and `useToggle` are @mantine/hooks; `useTimeout` is usehooks-ts.',
    'Sizes are minified, tree-shaken, with react left out, for the browser.',
  ],
  groups: [
    size({
      kind: 'size',
      id: 'local-storage',
      title: 'useLocalStorage',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/ui/hooks',
          package: '@arki/ui',
          limit: '2 kB',
          source: `export { useLocalStorage } from '@arki/ui/hooks/local-storage';`,
        },
        rehooks: {
          label: '@rehooks/local-storage (direct)',
          package: '@rehooks/local-storage',
          source: `export { useLocalStorage } from '@rehooks/local-storage';`,
        },
        usehooks: {
          label: 'usehooks-ts',
          package: 'usehooks-ts',
          source: `export { useLocalStorage } from 'usehooks-ts';`,
          differs: WRAPPED,
        },
        mantine: {
          label: '@mantine/hooks',
          package: '@mantine/hooks',
          source: `export { useLocalStorage } from '@mantine/hooks';`,
          differs: WRAPPED,
        },
        'react-use': {
          label: 'react-use',
          package: 'react-use',
          source: `export { useLocalStorage } from 'react-use';`,
          differs: WRAPPED,
        },
        ahooks: {
          label: 'ahooks (useLocalStorageState)',
          package: 'ahooks',
          source: `export { useLocalStorageState } from 'ahooks';`,
          differs: WRAPPED,
        },
      },
    }),
    size({
      kind: 'size',
      id: 'debounced-value',
      title: 'useDebouncedValue',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/ui/hooks',
          package: '@arki/ui',
          limit: '0.5 kB',
          source: `export { useDebouncedValue } from '@arki/ui/hooks/debounce';`,
        },
        mantine: {
          label: '@mantine/hooks (direct)',
          package: '@mantine/hooks',
          source: `export { useDebouncedValue } from '@mantine/hooks';`,
        },
        usehooks: {
          label: 'usehooks-ts (useDebounceValue)',
          package: 'usehooks-ts',
          source: `export { useDebounceValue } from 'usehooks-ts';`,
          differs: WRAPPED,
        },
        'react-use': {
          label: 'react-use (useDebounce)',
          package: 'react-use',
          source: `export { useDebounce } from 'react-use';`,
          differs: 'debounces a callback in an effect, not a value',
        },
        ahooks: {
          label: 'ahooks (useDebounce)',
          package: 'ahooks',
          source: `export { useDebounce } from 'ahooks';`,
          differs: WRAPPED,
        },
      },
    }),
    size({
      kind: 'size',
      id: 'media-query',
      title: 'useMediaQuery',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/ui/hooks',
          package: '@arki/ui',
          limit: '0.5 kB',
          source: `export { useMediaQuery } from '@arki/ui/hooks/media-query';`,
        },
        mantine: {
          label: '@mantine/hooks (direct)',
          package: '@mantine/hooks',
          source: `export { useMediaQuery } from '@mantine/hooks';`,
        },
        usehooks: {
          label: 'usehooks-ts',
          package: 'usehooks-ts',
          source: `export { useMediaQuery } from 'usehooks-ts';`,
          differs: WRAPPED,
        },
        'react-use': {
          label: 'react-use (useMedia)',
          package: 'react-use',
          source: `export { useMedia } from 'react-use';`,
          differs: WRAPPED,
        },
        ahooks: {
          label: 'ahooks (useResponsive)',
          package: 'ahooks',
          source: `export { useResponsive } from 'ahooks';`,
          differs: 'breakpoint object, not an arbitrary media query',
        },
      },
    }),
    size({
      kind: 'size',
      id: 'five-hooks',
      title: 'Five common hooks',
      note: 'Debounced value, media query, local storage, toggle, timeout.',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/ui/hooks',
          package: '@arki/ui',
          limit: '4 kB',
          source: `export { useDebouncedValue } from '@arki/ui/hooks/debounce';
export { useMediaQuery } from '@arki/ui/hooks/media-query';
export { useLocalStorage } from '@arki/ui/hooks/local-storage';
export { useToggle } from '@arki/ui/hooks/toggle';
export { useTimeout } from '@arki/ui/hooks/timeout';`,
        },
        wrapped: {
          label: 'wrapped libraries (direct)',
          package: '@mantine/hooks',
          source: `export { useDebouncedValue, useMediaQuery, useToggle } from '@mantine/hooks';
export { useLocalStorage } from '@rehooks/local-storage';
export { useTimeout } from 'usehooks-ts';`,
        },
        usehooks: {
          label: 'usehooks-ts',
          package: 'usehooks-ts',
          source: `export { useDebounceValue, useMediaQuery, useLocalStorage, useToggle, useTimeout } from 'usehooks-ts';`,
          differs: WRAPPED,
        },
        mantine: {
          label: '@mantine/hooks',
          package: '@mantine/hooks',
          source: `export { useDebouncedValue, useMediaQuery, useLocalStorage, useToggle, useTimeout } from '@mantine/hooks';`,
          differs: WRAPPED,
        },
        'react-use': {
          label: 'react-use',
          package: 'react-use',
          source: `export { useDebounce, useMedia, useLocalStorage, useToggle, useTimeout } from 'react-use';`,
          differs: WRAPPED,
        },
        ahooks: {
          label: 'ahooks',
          package: 'ahooks',
          source: `export { useDebounce, useResponsive, useLocalStorageState, useToggle, useTimeout } from 'ahooks';`,
          differs: WRAPPED,
        },
      },
    }),
  ],
});
