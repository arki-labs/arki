// Bundle size of the @arki/ui/theme provider and hook against next-themes.
// Run: `bun run bench`.

import { defineSuite, size } from '@arki/bench';

export default defineSuite({
  id: '@arki/ui/theme',
  intro:
    'Bundle size of the theme provider and hook in @arki/ui/theme against next-themes, the most used light/dark/system theme library for React.',
  notes: [
    'next-themes injects its no-flash script from inside its provider, so that script is already in its row. @arki/ui/theme exports the script separately (`@arki/ui/theme/script`) so you can inline it in your HTML head. The `with script` row adds it for a like-for-like size; next-themes still differs in API and behaviour, so it is not ranked.',
    'The script is built on the server and inlined in HTML. It is not part of the client bundle if you only call it on the server.',
  ],
  groups: [
    size({
      kind: 'size',
      id: 'provider-hook',
      title: 'ThemeProvider + useTheme',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/ui/theme',
          package: '@arki/ui',
          limit: '1.5 kB',
          source: `export { ThemeProvider, useTheme } from '@arki/ui/theme';`,
        },
        'arki-script': {
          label: '@arki/ui/theme (with script)',
          variant: true,
          package: '@arki/ui',
          limit: '1.5 kB',
          source: `export { ThemeProvider, useTheme } from '@arki/ui/theme';
export { themeScript } from '@arki/ui/theme/script';`,
        },
        'next-themes': {
          label: 'next-themes',
          package: 'next-themes',
          source: `export { ThemeProvider, useTheme } from 'next-themes';`,
          differs: 'provider carries its own no-flash script; props and storage format differ',
        },
      },
    }),
    size({
      kind: 'size',
      id: 'script',
      title: 'No-flash init script',
      note: 'The script is generated at build or render time on the server, and the string is inlined in HTML.',
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/ui/theme/script',
          package: '@arki/ui',
          limit: '1 kB',
          source: `export { themeScript } from '@arki/ui/theme/script';`,
        },
      },
    }),
  ],
});
