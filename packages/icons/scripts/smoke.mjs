// Cross-runtime smoke test. Renders a real icon to HTML and checks the data entries.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { siGithub } from '@arki/icons/brands';
import { spinnerNames } from '@arki/icons/spinners';
import { Acorn } from '@arki/icons/phosphor/ssr';

const html = renderToStaticMarkup(createElement(Acorn, { size: 24, weight: 'bold' }));
if (!html.startsWith('<svg') || !html.includes('width="24"')) {
  throw new Error(`icon did not render an svg: ${html.slice(0, 80)}`);
}
if (siGithub.title !== 'GitHub' || !siGithub.path.startsWith('M')) {
  throw new Error('brand data missing');
}
if (spinnerNames.length < 100 || !spinnerNames.includes('90-ring')) {
  throw new Error('spinner names missing');
}
console.log(`icons: 3 smoke checks passed (${spinnerNames.length} spinners)`);
