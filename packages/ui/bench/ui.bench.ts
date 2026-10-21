// Bundle size of the same components from @arki/ui and from other React component libraries.
// Run: `bun run bench`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

import { defineSuite, size } from '@arki/bench';

const SOURCE = new URL('../src/', import.meta.url);
// A copy of the workbench theme (tokens + Tailwind bridge), so the bench needs no theme package.
const TOKENS = new URL('theme/tokens.css', import.meta.url);

/**
 * The CSS an app's Tailwind v4 build would emit for the classes found in these @arki/ui files:
 * Tailwind's own scanner finds the classes, preflight and the workbench tokens + theme bridge
 * are included, plus `tw-animate-css` for the animate/fade/zoom/slide classes Select uses.
 * Written under the package's `.cache/` and imported by a path relative to the size entries
 * (`.cache/bench-size/`), so the suite's hash is the same on every machine.
 */
async function tailwindCssFor(name: string, files: readonly string[]): Promise<string> {
  const contents = files.map(file => ({
    content: readFileSync(new URL(file, SOURCE), 'utf8'),
    extension: 'tsx',
  }));
  const candidates = new Scanner({}).scanFiles(contents);
  const tokens = readFileSync(TOKENS, 'utf8').replace(/^@import '\.\/fonts\.css';\s*$/m, '');
  const compiler = await compile(
    `@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/preflight.css' layer(base);
@import './bench/theme/theme-bridge.css';
@import 'tw-animate-css';
@tailwind utilities;
${tokens}`,
    {
      base: new URL('..', import.meta.url).pathname,
      onDependency: () => {
        /* dependency notices are irrelevant to the timing */
      },
    },
  );
  const dir = new URL('../.cache/bench-ui/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${name}.css`, dir), compiler.build(candidates));
  return `../bench-ui/${name}.css`;
}

const buttonCss = await tailwindCssFor('button', ['button.tsx']);
const dialogCss = await tailwindCssFor('dialog', ['dialog.tsx', 'button.tsx']);
const formCss = await tailwindCssFor('form', ['button.tsx', 'input.tsx', 'select.tsx', 'checkbox.tsx']);

const NEEDS_CSS = 'ships a separate stylesheet that this row does not count';
const RUNTIME_CSS = 'styles are injected at runtime by Emotion (CSS-in-JS), not a stylesheet';

const buttonArki = `export { Button } from '@arki/ui/button';`;
const dialogArki = `export { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@arki/ui/dialog';`;
const formArki = `export { Button } from '@arki/ui/button';
export { Input } from '@arki/ui/input';
export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@arki/ui/select';
export { Checkbox } from '@arki/ui/checkbox';`;

const buttonRivals = {
  mantine: `export { Button } from '@mantine/core';`,
  mui: `export { Button } from '@mui/material';`,
  radix: `export { Button } from '@radix-ui/themes';`,
};
const dialogRivals = {
  mantine: `export { Modal } from '@mantine/core';`,
  mui: `export { Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions } from '@mui/material';`,
  radix: `export { Dialog } from '@radix-ui/themes';`,
};
const formRivals = {
  mantine: `export { Button, TextInput, Select, Checkbox } from '@mantine/core';`,
  mui: `export { Button, TextField, Select, MenuItem, Checkbox } from '@mui/material';`,
  radix: `export { Button, TextField, Select, Checkbox } from '@radix-ui/themes';`,
};

const MANTINE_CSS = `import '@mantine/core/styles.css';\n`;
const RADIX_CSS = `import '@radix-ui/themes/styles.css';\n`;

/** JavaScript only: the components without their styles. Rivals are never ranked here. */
function jsGroup(id: string, title: string, arki: string, limit: string, rivals: typeof buttonRivals) {
  return size({
    kind: 'size',
    id,
    title: `${title}, JavaScript only`,
    baseline: 'arki',
    cases: {
      arki: { label: '@arki/ui', package: '@arki/ui', source: arki, limit },
      mantine: { label: '@mantine/core', package: '@mantine/core', source: rivals.mantine, differs: NEEDS_CSS },
      mui: { label: '@mui/material', package: '@mui/material', source: rivals.mui, differs: RUNTIME_CSS },
      radix: { label: '@radix-ui/themes', package: '@radix-ui/themes', source: rivals.radix, differs: NEEDS_CSS },
    },
  });
}

/** JavaScript plus the stylesheet a user must also ship to see the component styled. */
function styledGroup(id: string, title: string, arki: string, css: string, limit: string, rivals: typeof buttonRivals) {
  return size({
    kind: 'size',
    id,
    title: `${title}, complete styled`,
    baseline: 'arki',
    cases: {
      arki: {
        label: '@arki/ui + Tailwind CSS',
        package: '@arki/ui',
        source: `import '${css}';\n${arki}`,
        limit,
      },
      mantine: {
        label: '@mantine/core + styles.css',
        package: '@mantine/core',
        source: MANTINE_CSS + rivals.mantine,
      },
      mui: { label: '@mui/material (Emotion)', package: '@mui/material', source: rivals.mui },
      radix: {
        label: '@radix-ui/themes + styles.css',
        package: '@radix-ui/themes',
        source: RADIX_CSS + rivals.radix,
      },
    },
  });
}

export default defineSuite({
  id: '@arki/ui',
  intro:
    'Bundle size of the same components from @arki/ui and from popular React component libraries. Mantine, MUI and Radix Themes are the common full-featured choices.',
  notes: [
    'Styling is not equal, so there are two kinds of group. `JavaScript only` counts the components without styles; a rival that needs a stylesheet or styles itself at runtime is measured but never ranked (`differs`). `complete styled` adds the CSS a user must also ship, and ranks everything.',
    '@arki/ui is Base UI primitives styled with Tailwind classes. Its CSS comes from your app Tailwind build. In the `complete styled` groups it is a Tailwind v4 build of the classes found in the measured component files (found by Tailwind’s own scanner), with preflight and the workbench tokens and theme bridge. Fonts are left out. A real app adds the classes of its own code on top.',
    'Mantine and Radix Themes ship one stylesheet for the whole library (`styles.css`), not a per-component one, so their complete rows include the CSS of every component. MUI styles components at runtime with Emotion, so its JavaScript includes the styling engine and it has no stylesheet.',
    'Mantine `Modal` and MUI/Radix `Dialog` are the nearest equivalents of the @arki/ui Dialog parts.',
  ],
  groups: [
    jsGroup('button-js', 'Button', buttonArki, '14.5 kB', buttonRivals),
    jsGroup('dialog-js', 'Dialog', dialogArki, '35.5 kB', dialogRivals),
    jsGroup('form-js', 'Form set (Button, Input, Select, Checkbox)', formArki, '63.5 kB', formRivals),
    styledGroup('button-styled', 'Button', buttonArki, buttonCss, '18.5 kB', buttonRivals),
    styledGroup('dialog-styled', 'Dialog', dialogArki, dialogCss, '41 kB', dialogRivals),
    styledGroup('form-styled', 'Form set (Button, Input, Select, Checkbox)', formArki, formCss, '69 kB', formRivals),
  ],
});
