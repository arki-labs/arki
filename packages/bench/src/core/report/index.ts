// Renderers turn a saved result into text. They never measure and never print.
export { renderText, type TextOptions } from './text.js';
export { renderMarkdown, DEFAULT_REPRODUCE, type MarkdownOptions } from './markdown.js';
export { renderComparison } from './comparison.js';
export { renderLosses, type LossesOptions } from './losses.js';
