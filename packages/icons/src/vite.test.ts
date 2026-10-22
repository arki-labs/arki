/**
 * `@arki/icons/vite` must turn index imports into per-icon imports without
 * changing what the app sees: same names, same aliases, type names and
 * unknown names left where they were, line count preserved so stack traces
 * still point at the right line. The build test checks the real effect: a
 * server bundle that imports one icon's module and not the whole index.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import { phosphorIconNames, phosphorPerIcon, rewriteIconImports } from './vite';

const icons: ReadonlySet<string> = new Set(['Heart', 'Trash', 'Plus']);
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'vite');

describe('rewriteIconImports', () => {
  it('gives each icon its own import and keeps aliases', () => {
    expect(rewriteIconImports(`import { Heart, Trash as Bin } from '@arki/icons/phosphor';\nrender();`, icons)).toBe(
      `import { Heart } from '@phosphor-icons/react/dist/csr/Heart'; import { Trash as Bin } from '@phosphor-icons/react/dist/csr/Trash';\nrender();`,
    );
  });

  it('maps the Icon-suffixed name to the same module and IconContext to the context module', () => {
    expect(rewriteIconImports(`import { HeartIcon, IconContext } from '@phosphor-icons/react';`, icons)).toBe(
      `import { HeartIcon } from '@phosphor-icons/react/dist/csr/Heart'; import { IconContext } from '@phosphor-icons/react/dist/lib/context';`,
    );
  });

  it('leaves type names, `type` specifiers and unknown names on the original source', () => {
    expect(
      rewriteIconImports(`import { Heart, type IconWeight, IconProps, Sparkle } from '@arki/icons/phosphor';`, icons),
    ).toBe(
      `import { Heart } from '@phosphor-icons/react/dist/csr/Heart'; import { type IconWeight, IconProps, Sparkle } from '@arki/icons/phosphor';`,
    );
  });

  it('keeps the line count of a multi-line import, so later lines keep their numbers', () => {
    const code = `import {\n  Heart,\n  Plus,\n} from "@arki/icons/phosphor";\nconst after = 1;`;
    const out = rewriteIconImports(code, icons);
    expect(out.split('\n').length).toBe(code.split('\n').length);
    expect(out.split('\n').at(-1)).toBe('const after = 1;');
    expect(out).toContain(`import { Heart } from "@phosphor-icons/react/dist/csr/Heart";`);
  });

  it('returns the code unchanged when nothing is an icon import', () => {
    const code = `import { IconContextValue } from '@arki/icons/phosphor';\nimport { Heart } from './local';`;
    expect(rewriteIconImports(code, icons)).toBe(code);
  });
});

describe('phosphorIconNames', () => {
  it('reads the installed Phosphor package: Heart is an icon, HeartIcon is not a module', () => {
    const names = phosphorIconNames();
    expect(names.has('Heart')).toBe(true);
    expect(names.has('HeartIcon')).toBe(false);
    expect(names.size).toBeGreaterThan(1000);
  });
});

describe('phosphorPerIcon in `vite build`', () => {
  it('server bundle imports the icon module, never the Phosphor index', async () => {
    const result = await build({
      root: fixtures,
      configFile: false,
      logLevel: 'silent',
      plugins: [phosphorPerIcon()],
      build: { ssr: 'icon-entry.ts', write: false },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const code = outputs
      .flatMap(output => ('output' in output ? output.output : []))
      .map(chunk => ('code' in chunk ? chunk.code : ''))
      .join('\n');
    expect(code).toMatch(/@phosphor-icons\/react\/dist\/csr\/Heart/);
    expect(code).toMatch(/@phosphor-icons\/react\/dist\/lib\/context/);
    expect(code).not.toMatch(/from\s*["']@phosphor-icons\/react["']/);
  });
});
