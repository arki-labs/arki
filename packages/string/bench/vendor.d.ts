// lodash-es and escape-html ship no types: declare only what string.bench.ts
// calls. It has to live in an ambient file, because a module file cannot
// augment an untyped package.
declare module 'lodash-es' {
  export function camelCase(text: string): string;
  export function kebabCase(text: string): string;
  export function truncate(text: string, options: { length: number; omission: string }): string;
  export function escape(text: string): string;
  export function escapeRegExp(text: string): string;
}

declare module 'escape-html' {
  export default function escapeHtml(text: string): string;
}
