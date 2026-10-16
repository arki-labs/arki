/**
 * One small HTML layout for the built-in templates. Every interpolated value is HTML-escaped, and
 * the button link must be http(s): a `javascript:` or `data:` link in a mail is an attack.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replaceAll(/[&<>"']/g, char => HTML_ESCAPES[char] ?? char);
}

/** True for an absolute `http:` or `https:` URL. */
export function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

export type LayoutContent = {
  /** The heading, and the page title. */
  readonly title: string;
  /** Paragraphs before the button or code. */
  readonly intro: readonly string[];
  /** A button. Its URL must be http(s); template schemas check this first. */
  readonly action?: { readonly label: string; readonly url: string };
  /** A one-time code shown in large type. */
  readonly code?: string;
  /** Paragraphs after the button or code. */
  readonly outro: readonly string[];
};

const paragraph = (text: string): string =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#374151">${escapeHtml(text)}</p>`;

/** Renders `content` as a complete HTML document. Throws on a non-http(s) action URL: that is a bug. */
export function layout(content: LayoutContent): string {
  if (content.action !== undefined && !isHttpUrl(content.action.url)) {
    throw new TypeError('layout: the action URL must be http(s).');
  }
  const action =
    content.action === undefined
      ? ''
      : `<p style="margin:24px 0"><a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#111827;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${escapeHtml(content.action.label)}</a></p>` +
        paragraph(`Or open this link: ${content.action.url}`);
  const code =
    content.code === undefined
      ? ''
      : `<p style="margin:24px 0;font-size:28px;font-weight:700;letter-spacing:6px;color:#111827">${escapeHtml(content.code)}</p>`;
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
    `<title>${escapeHtml(content.title)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">',
    '<div style="max-width:480px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px">',
    `<h1 style="margin:0 0 24px;font-size:22px;color:#111827">${escapeHtml(content.title)}</h1>`,
    ...content.intro.map(text => paragraph(text)),
    action,
    code,
    ...content.outro.map(text => paragraph(text)),
    '</div></body></html>',
  ].join('');
}
