/**
 * Renders a React Email component to the HTML and plain-text parts of a mail. Use it inside a
 * template's `html` and `text` renderers. Needs the optional peers `react` and
 * `@react-email/render`.
 *
 * @example
 * const { html, text } = await renderReact(createElement(MagicLinkEmail, { loginUrl, appName }));
 */
import type { ReactElement } from 'react';
import { render } from '@react-email/render';

export async function renderReact(element: ReactElement): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}
