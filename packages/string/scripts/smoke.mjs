// Cross-runtime smoke test, run by `arki-runtimes` on every engine. On Node and
// Bun it also re-runs itself with `--no-intl-segmenter`, which deletes
// `Intl.Segmenter` first so the in-house UAX #29 scanner runs end to end, as it
// does on React Native (Hermes).
// Imports the built `dist/` (run `bun run build` first) and exercises one
// operation per subpath so a runtime gap fails loudly on every engine.

const forceFallback = globalThis.process?.argv?.includes('--no-intl-segmenter') ?? false;
if (forceFallback) delete Intl.Segmenter;

const s = await import('../dist/index.js');

const runtime = globalThis.Deno
  ? `deno ${globalThis.Deno.version.deno}`
  : globalThis.Bun
    ? `bun ${globalThis.Bun.version}`
    : `node ${globalThis.process?.version ?? '?'}${forceFallback ? ' (no Intl.Segmenter)' : ''}`;
const checks = [];
const check = (name, actual, expected) => checks.push({ name, ok: actual === expected, actual, expected });

// Hermes V1 has no Intl.Segmenter, so it always runs the fallback path.
check('segmenter state', typeof Intl.Segmenter === 'function', !forceFallback && typeof HermesInternal === 'undefined');
check('unicode length', s.length('👨‍👩‍👧‍👦é'), 2);
check('unicode at', s.at('A👩‍💻B', 1), '👩‍💻');
check('unicode flag tags', s.length('🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'), 1);
check('unicode reverse', s.reverse('🇷🇴é'), 'é🇷🇴');
check('case camel', s.camelCase('XMLHttpRequest v2Beta'), 'xmlHttpRequestV2Beta');
check('case turkish', s.titleCase('istanbul', { locale: 'tr' }), 'İstanbul');
check('format truncate', s.truncate('The quick brown fox', 10, { boundary: 'word-before' }), 'The quick…');
check('format initials', s.initials('Ada King Lovelace'), 'AL');
check('segment words', s.wordCount("don't re-enter 3.14"), 3);
check('segment sentences', s.sentenceCount('One. Two! Three?'), 3);
check('search between', s.between('a[b]c', '[', ']'), 'b');
check('edit replaceAll', s.replaceAll('é e', 'e', 'X'), 'é X');
check('edit mask', s.mask('4111111111111111', { end: -4 }), '************1111');
check('escape regexp', s.escapeRegExp('.b'), String.raw`\.b`); // a leading alphanumeric would be hex-escaped, as RegExp.escape does
check('interpolate', s.interpolate('Hi {{ name }}', { name: 'Ada' }), 'Hi Ada');
check('slug', s.slugify('Привет мир & fooBar'), 'privet-mir-and-foo-bar');
check('base64 roundtrip', s.fromBase64(s.toBase64('crème brûlée 👋')), 'crème brûlée 👋');
check('base64 strict', s.InvalidBase64.is(s.tryFromBase64('Zg=')), true);
check('utf8 strict', s.InvalidUtf8.is(s.fromBase64('/w==')), true);
check('surrogate strict', s.InvalidUtf8.is(s.toBase64('\uD800')), true);
check('readability level', s.fleschReadingEaseLevel(95), 'Very Easy');
check('readability syllables', s.syllableCount('justification table'), 7);
check('keywords', s.keywords('deep learning, deep learning', { length: 2 })[0]?.keyword, 'deep learning');
check('vocabulary', s.uniqueWordCount('The the cat'), 2);
check('metrics', s.textMetrics('Hi there. Bye.').sentences, 2);
check('hash', s.hashCode('hello'), 99_162_322);
check('distance', s.levenshtein('kitten', 'sitting'), 3);
check('unicode fold', s.fold('Émile Łódź'), 'emile lodz');
check('format dedent', s.dedent('\n  a\n    b\n'), 'a\n  b');
check('readability es', typeof s.readability('Hola mundo.', { language: 'es' }).fernandezHuerta, 'number');
check('fluent', s.str('  XML_http_request  ').squish().titleCase().value(), 'Xml Http Request');

const failed = checks.filter(c => !c.ok);
for (const c of failed) console.error(`✗ ${c.name}: expected ${String(c.expected)}, got ${String(c.actual)}`);
console.log(`${runtime}: ${checks.length - failed.length}/${checks.length} smoke checks passed`);
if (failed.length > 0) throw new Error(`${failed.length} smoke check(s) failed on ${runtime}`);

// The fallback run. The segmenter is cached on first use, so it needs a fresh process.
const onNodeOrBun = !forceFallback && (globalThis.Bun || globalThis.process?.versions?.node) && !globalThis.Deno;
if (onNodeOrBun) {
  // `getBuiltinModule`, not `import()`: it keeps `bun build --target=browser` from bundling the Node builtin, and Hermes rejects `import()` as a syntax error even in code that never runs there.
  const { spawnSync } = globalThis.process.getBuiltinModule('node:child_process');
  // `process.argv[1]`, not `import.meta.url`: Hermes rejects `import.meta` as a syntax error even in code that never runs there.
  const result = spawnSync(globalThis.process.execPath, [globalThis.process.argv[1], '--no-intl-segmenter'], {
    encoding: 'utf8',
  });
  globalThis.process.stdout.write(result.stdout);
  globalThis.process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`the no-Intl.Segmenter run failed (exit ${result.status})`);
}
