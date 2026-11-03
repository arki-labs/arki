'use client';

import type { Extension } from '@codemirror/state';
import { useMemo } from 'react';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';

/** All syntax languages supported by the shared code editor. */
export type CodeEditorLanguage =
  | 'json'
  | 'yaml'
  | 'xml'
  | 'markdown'
  | 'typescript'
  | 'javascript'
  | 'css'
  | 'html'
  | 'python'
  | 'sql'
  | 'toml'
  | 'text';

export type CodeEditorProps = {
  value: string;
  onChange?: (value: string) => void;
  language?: CodeEditorLanguage;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  /**
   * CodeMirror theme extension. Use `getTheme(id).extension` from
   * `@arki/code-editor/themes` to obtain this value from the app's
   * own `editorThemeAtom` — the editor itself does not read any atoms.
   */
  theme?: Extension;
  /** When true, enables line numbers in the gutter. Default: false. */
  lineNumbers?: boolean;
};

const languageExtensions: Partial<Record<CodeEditorLanguage, () => Extension>> = {
  json: () => json(),
  yaml: () => yaml(),
  xml: () => xml(),
  markdown: () => markdown(),
  typescript: () => javascript({ typescript: true }),
  javascript: () => javascript(),
  css: () => css(),
  html: () => html(),
  python: () => python(),
  sql: () => sql(),
};

/** `toml` and `text` have no entry, so they render without highlighting. */
function getLanguageExtension(language: CodeEditorLanguage): Extension | null {
  return languageExtensions[language]?.() ?? null;
}

/**
 * A syntax-highlighted code editor / viewer built on CodeMirror 6.
 *
 * The active theme is injected via the `theme` prop — this component does not
 * read any Jotai atoms directly, keeping it framework-agnostic.  Each
 * consuming app reads its own `editorThemeAtom` and passes
 * `getTheme(themeId).extension` as the `theme` prop.
 */
export function CodeEditor({
  value,
  onChange,
  language = 'text',
  readOnly = false,
  placeholder,
  className,
  ariaLabel,
  theme,
  lineNumbers = false,
}: CodeEditorProps) {
  const extensions = useMemo(() => {
    const exts: Extension[] = [EditorView.lineWrapping];
    const langExt = getLanguageExtension(language);
    if (langExt) exts.push(langExt);
    if (ariaLabel) exts.push(EditorView.contentAttributes.of({ 'aria-label': ariaLabel }));
    return exts;
  }, [language, ariaLabel]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={theme}
      readOnly={readOnly}
      placeholder={placeholder}
      height="100%"
      className={className}
      style={{ height: '100%' }}
      basicSetup={{
        lineNumbers,
        foldGutter: false,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: !readOnly,
        autocompletion: false,
        rectangularSelection: false,
        crosshairCursor: false,
        highlightSelectionMatches: false,
        searchKeymap: false,
        history: !readOnly,
      }}
    />
  );
}
