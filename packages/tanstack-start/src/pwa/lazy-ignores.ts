/**
 * Curated `globIgnores` patterns for known dynamically-imported chunk
 * families. Pass these into {@link CreatePwaPluginOptions.injectManifest}'s
 * `globIgnores` to exclude chunks that the runtime fetches on demand,
 * shrinking the precache manifest without affecting features.
 *
 * Each chunk family corresponds to a library that uses `import()` to
 * load assets the first time a user actually needs them:
 *
 * - **Shiki** loads a separate ESM bundle per TextMate grammar
 *   (e.g. `cpp-DhlOAK4K.js`) and per theme (e.g. `gruvbox-light-hard-*.js`)
 *   on first render of a code block in that language/theme.
 * - **Mermaid** loads one chunk per diagram renderer (e.g. `sequenceDiagram-*.js`)
 *   on first render of that diagram type.
 *
 * Precaching these wastes bandwidth and storage — most users will only
 * ever hit a small subset. The browser still caches what does get loaded,
 * and the SW will fall through to the network for anything missed.
 *
 * Filenames are emitted by Rolldown as `<lib-module-name>-<hash>.js`,
 * so a prefix-with-literal-hyphen glob (`cpp-*.js`) is precise enough
 * to avoid colliding with similarly-named user chunks (`cpp17-...` would
 * still match if it existed; nothing else does).
 */

/**
 * All shiki TextMate grammar identifiers. Source: `shiki/dist/langs/*`.
 * Update when shiki adds new grammars.
 */
const SHIKI_LANGS = [
  'abap',
  'actionscript-3',
  'ada',
  'angular-html',
  'angular-ts',
  'apache',
  'apex',
  'apl',
  'applescript',
  'ara',
  'asciidoc',
  'asm',
  'astro',
  'awk',
  'ballerina',
  'bat',
  'beancount',
  'berry',
  'bibtex',
  'bicep',
  'blade',
  'bsl',
  'c',
  'cadence',
  'cairo',
  'clarity',
  'clj',
  'clojure',
  'cmake',
  'cobol',
  'codeowners',
  'codeql',
  'coffee',
  'common-lisp',
  'coq',
  'cpp',
  'crystal',
  'csharp',
  'css',
  'csv',
  'cue',
  'cypher',
  'd',
  'dart',
  'dax',
  'desktop',
  'diff',
  'docker',
  'dotenv',
  'dream-maker',
  'edge',
  'elixir',
  'elm',
  'emacs-lisp',
  'erb',
  'erlang',
  'fennel',
  'fish',
  'fluent',
  'fortran-fixed-form',
  'fortran-free-form',
  'fsharp',
  'fsl',
  'gdresource',
  'gdscript',
  'gdshader',
  'genie',
  'gherkin',
  'git-commit',
  'git-rebase',
  'gleam',
  'glimmer-js',
  'glimmer-ts',
  'glsl',
  'gnuplot',
  'go',
  'graphql',
  'groovy',
  'hack',
  'haml',
  'handlebars',
  'haskell',
  'haxe',
  'hcl',
  'hjson',
  'hlsl',
  'html',
  'http',
  'hxml',
  'hy',
  'imba',
  'ini',
  'java',
  'javascript',
  'jinja',
  'jison',
  'json',
  'jsonc',
  'jsonl',
  'jsonnet',
  'jssm',
  'jsx',
  'julia',
  'kotlin',
  'kusto',
  'latex',
  'lean',
  'less',
  'liquid',
  'llvm',
  'log',
  'logo',
  'lua',
  'luau',
  'make',
  'markdown',
  'marko',
  'matlab',
  'mdc',
  'mdx',
  'mermaid',
  'mipsasm',
  'mmd',
  'mojo',
  'move',
  'narrat',
  'nextflow',
  'nginx',
  'nim',
  'nix',
  'nushell',
  'objective-c',
  'objective-cpp',
  'ocaml',
  'pascal',
  'perl',
  'php',
  'plsql',
  'po',
  'polar',
  'postcss',
  'powerquery',
  'powershell',
  'prisma',
  'prolog',
  'proto',
  'pug',
  'puppet',
  'purescript',
  'python',
  'qml',
  'qmldir',
  'qss',
  'r',
  'racket',
  'raku',
  'razor',
  'reg',
  'regexp',
  'rel',
  'riscv',
  'rst',
  'ruby',
  'rust',
  'sas',
  'sass',
  'scala',
  'scheme',
  'scss',
  'sdbl',
  'shaderlab',
  'shellscript',
  'shellsession',
  'smalltalk',
  'solidity',
  'soy',
  'sparql',
  'splunk',
  'sql',
  'ssh-config',
  'stata',
  'stylus',
  'svelte',
  'swift',
  'system-verilog',
  'systemd',
  'talonscript',
  'tasl',
  'tcl',
  'templ',
  'terraform',
  'tex',
  'toml',
  'ts-tags',
  'tsv',
  'tsx',
  'turtle',
  'twig',
  'typescript',
  'typespec',
  'typst',
  'v',
  'vala',
  'vb',
  'verilog',
  'vhdl',
  'viml',
  'vue',
  'vue-html',
  'vue-vine',
  'vyper',
  'wasm',
  'wenyan',
  'wgsl',
  'wikitext',
  'wit',
  'wolfram',
  'xml',
  'xsl',
  'yaml',
  'zenscript',
  'zig',
] as const;

/**
 * All shiki theme identifiers. Source: `shiki/dist/themes/*`.
 */
const SHIKI_THEMES = [
  'andromeeda',
  'aurora-x',
  'ayu-dark',
  'catppuccin-frappe',
  'catppuccin-latte',
  'catppuccin-macchiato',
  'catppuccin-mocha',
  'dark-plus',
  'dracula',
  'dracula-soft',
  'everforest-dark',
  'everforest-light',
  'github-dark',
  'github-dark-default',
  'github-dark-dimmed',
  'github-dark-high-contrast',
  'github-light',
  'github-light-default',
  'github-light-high-contrast',
  'gruvbox-dark-hard',
  'gruvbox-dark-medium',
  'gruvbox-dark-soft',
  'gruvbox-light-hard',
  'gruvbox-light-medium',
  'gruvbox-light-soft',
  'houston',
  'kanagawa-dragon',
  'kanagawa-lotus',
  'kanagawa-wave',
  'laserwave',
  'light-plus',
  'material-theme',
  'material-theme-darker',
  'material-theme-lighter',
  'material-theme-ocean',
  'material-theme-palenight',
  'min-dark',
  'min-light',
  'monokai',
  'night-owl',
  'nord',
  'one-dark-pro',
  'one-light',
  'plastic',
  'poimandres',
  'red',
  'rose-pine',
  'rose-pine-dawn',
  'rose-pine-moon',
  'slack-dark',
  'slack-ochin',
  'snazzy-light',
  'solarized-dark',
  'solarized-light',
  'synthwave-84',
  'tokyo-night',
  'vesper',
  'vitesse-black',
  'vitesse-dark',
  'vitesse-light',
] as const;

/**
 * Shiki language grammar chunk patterns.
 *
 * Each grammar lands at `assets/<lang>-<hash>.js` — only loaded when a
 * code block in that language renders. Precaching all 200+ wastes ~7 MB
 * for a typical app.
 */
export const SHIKI_LANG_IGNORES: readonly string[] = SHIKI_LANGS.map(
  (lang) => `**/${lang}-*.js`,
);

/**
 * Shiki theme chunk patterns.
 *
 * Each theme lands at `assets/<theme>-<hash>.js` — only loaded when shiki
 * is configured to use that theme.
 */
export const SHIKI_THEME_IGNORES: readonly string[] = SHIKI_THEMES.map(
  (theme) => `**/${theme}-*.js`,
);

/**
 * Mermaid diagram-renderer chunk patterns.
 *
 * Mermaid uses `import()` for each diagram type. The chunk filename is
 * the renderer module name (e.g. `sequenceDiagram-*.js`,
 * `architectureDiagram-*.js`, `flowchart-*.js`). Only the diagram types
 * actually used at runtime need to be loaded.
 */
export const MERMAID_DIAGRAM_IGNORES: readonly string[] = [
  '**/*Diagram-*.js',
  '**/flowchart-*.js',
  '**/timeline-*.js',
  '**/gantt-*.js',
  '**/pie-*.js',
  '**/journey-*.js',
  '**/sankey-*.js',
  '**/xychart-*.js',
  '**/quadrant-*.js',
  '**/mindmap-*.js',
  '**/c4-*.js',
  '**/er-*.js',
  '**/kanban-*.js',
  '**/radar-*.js',
];

/**
 * All known lazy-chunk patterns combined.
 *
 * Spread into `injectManifest.globIgnores` to exclude every chunk family
 * this module knows about in a single line:
 *
 * @example
 * ```ts
 * createPwaPlugin({
 *   injectManifest: {
 *     globIgnores: [...LAZY_CHUNK_IGNORES],
 *   },
 * });
 * ```
 */
export const LAZY_CHUNK_IGNORES: readonly string[] = [
  ...SHIKI_LANG_IGNORES,
  ...SHIKI_THEME_IGNORES,
  ...MERMAID_DIAGRAM_IGNORES,
];
