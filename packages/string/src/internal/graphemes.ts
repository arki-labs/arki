/**
 * Grapheme-cluster segmentation.
 *
 * Uses the engine's `Intl.Segmenter` when present. Otherwise falls back to an
 * in-house implementation of UAX #29 extended grapheme clusters driven by Unicode
 * property escapes, so the engine's own Unicode tables supply the character data
 * and nothing is pinned in this package. The fallback exists for Hermes (React
 * Native), which has no `Intl.Segmenter`.
 */

const CR = 0x0d;
const LF = 0x0a;
const ZWJ = 0x20_0d;
const ZWNJ = 0x20_0c;

/** Grapheme_Cluster_Break property values used by the fallback scanner. */
const Other = 0;
const Control = 1;
const Extend = 2;
const RegionalIndicator = 3;
const Prepend = 4;
const SpacingMark = 5;
const HangulL = 6;
const HangulV = 7;
const HangulT = 8;
const HangulLV = 9;
const HangulLVT = 10;
const ExtendedPictographic = 11;

type BreakClass =
  | typeof Other
  | typeof Control
  | typeof Extend
  | typeof RegionalIndicator
  | typeof Prepend
  | typeof SpacingMark
  | typeof HangulL
  | typeof HangulV
  | typeof HangulT
  | typeof HangulLV
  | typeof HangulLVT
  | typeof ExtendedPictographic;

const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}\p{Cs}]/u;
const EXTEND_RE = /[\p{Grapheme_Extend}\p{Emoji_Modifier}]/u;
const REGIONAL_INDICATOR_RE = /\p{Regional_Indicator}/u;
const SPACING_MARK_RE = /\p{Mc}/u;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

/**
 * GB9c (conjunct clusters). Consonants approximate `InCB=Consonant` as any letter of
 * the scripts that take part in the rule; linkers are their viramas (`InCB=Linker`).
 */
const INDIC_CONSONANT_RE =
  /[\p{Script=Bengali}\p{Script=Devanagari}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Oriya}\p{Script=Telugu}\p{Script=Myanmar}\p{Script=Balinese}\p{Script=Khmer}]/u;
const INDIC_LINKERS = new Set([
  0x09_4d, 0x09_cd, 0x0a_4d, 0x0a_cd, 0x0b_4d, 0x0c_4d, 0x0c_cd, 0x0d_4d, 0x10_39, 0x17_d2, 0x1b_44, 0x1c_f5, 0x1c_f6,
]);
const LETTER_RE = /\p{L}/u;

/** Mc characters that UAX #29 excludes from SpacingMark. */
const SPACING_MARK_EXCEPTIONS = new Set([
  0x10_2b, 0x10_2c, 0x10_38, 0x10_62, 0x10_63, 0x10_64, 0x10_67, 0x10_68, 0x10_69, 0x10_6a, 0x10_6b, 0x10_6c, 0x10_6d,
  0x10_83, 0x10_87, 0x10_88, 0x10_89, 0x10_8a, 0x10_8b, 0x10_8c, 0x10_8f, 0x10_9a, 0x10_9b, 0x10_9c, 0x1a_61, 0x1a_63,
  0x1a_64, 0xaa_7b, 0xaa_7d, 0x1_17_20, 0x1_17_21,
]);
/** Non-Mc characters that UAX #29 adds to SpacingMark. */
const SPACING_MARK_ADDITIONS = new Set([0x0e_33, 0x0e_b3]);

/** Prepend: Prepended_Concatenation_Mark characters plus Indic prefixed consonants and rephas. */
const PREPEND_CHARACTERS = new Set([
  0x06_00, 0x06_01, 0x06_02, 0x06_03, 0x06_04, 0x06_05, 0x06_dd, 0x07_0f, 0x08_90, 0x08_91, 0x08_e2, 0x1_10_bd,
  0x1_10_cd, 0x0d_4e, 0x1_11_c2, 0x1_11_c3, 0x1_19_3f, 0x1_19_41, 0x1_1a_3a, 0x1_1a_84, 0x1_1a_85, 0x1_1a_86, 0x1_1a_87,
  0x1_1a_88, 0x1_1a_89, 0x1_1d_46, 0x1_1f_02,
]);

/** Format characters that UAX #29 excludes from Control. */
const CONTROL_EXCEPTIONS = new Set([ZWNJ, ZWJ]);

function hangulClass(cp: number): BreakClass | undefined {
  if ((cp >= 0x11_00 && cp <= 0x11_5f) || (cp >= 0xa9_60 && cp <= 0xa9_7c)) return HangulL;
  if ((cp >= 0x11_60 && cp <= 0x11_a7) || (cp >= 0xd7_b0 && cp <= 0xd7_c6)) return HangulV;
  if ((cp >= 0x11_a8 && cp <= 0x11_ff) || (cp >= 0xd7_cb && cp <= 0xd7_fb)) return HangulT;
  if (cp >= 0xac_00 && cp <= 0xd7_a3) return (cp - 0xac_00) % 28 === 0 ? HangulLV : HangulLVT;
  return undefined;
}

function classify(cp: number): BreakClass {
  const ch = String.fromCodePoint(cp);
  if (cp === ZWJ) return Extend;
  if (REGIONAL_INDICATOR_RE.test(ch)) return RegionalIndicator;
  if (PREPEND_CHARACTERS.has(cp)) return Prepend;
  if (CONTROL_RE.test(ch) && !CONTROL_EXCEPTIONS.has(cp)) return Control;
  if (EXTEND_RE.test(ch)) return Extend;
  if (SPACING_MARK_ADDITIONS.has(cp) || (SPACING_MARK_RE.test(ch) && !SPACING_MARK_EXCEPTIONS.has(cp))) {
    return SpacingMark;
  }
  const hangul = hangulClass(cp);
  if (hangul !== undefined) return hangul;
  if (EXTENDED_PICTOGRAPHIC_RE.test(ch)) return ExtendedPictographic;
  return Other;
}

function isIndicConsonant(cp: number): boolean {
  const ch = String.fromCodePoint(cp);
  return INDIC_CONSONANT_RE.test(ch) && LETTER_RE.test(ch);
}

/**
 * Boundary offsets (UTF-16 code-unit indices) produced by the in-house UAX #29
 * scanner. Exported for tests that must exercise the fallback regardless of the
 * host engine; application code should use `graphemeBoundaries`.
 */
export function fallbackBoundaries(text: string): number[] {
  const boundaries: number[] = [0];
  if (text.length === 0) return boundaries;

  let index = 0;
  let previousCp = -1;
  let previous: BreakClass = Other;
  let regionalIndicatorRun = 0;
  /** GB11: an Extended_Pictographic followed only by Extend characters. */
  let pictographicRun = false;
  /** GB9c: a Linker followed only by Extend/Linker characters. */
  let indicLinkerSeen = false;

  while (index < text.length) {
    const cp = text.codePointAt(index);
    if (cp === undefined) break;
    const width = cp > 0xff_ff ? 2 : 1;
    const current = classify(cp);

    if (index > 0) {
      let breakHere = true;

      if (previousCp === CR && cp === LF) {
        breakHere = false; // GB3
      } else if (previous === Control || previousCp === CR || previousCp === LF) {
        breakHere = true; // GB4
      } else if (current === Control || cp === CR || cp === LF) {
        breakHere = true; // GB5
      } else if (
        previous === HangulL &&
        (current === HangulL || current === HangulV || current === HangulLV || current === HangulLVT)
      ) {
        breakHere = false; // GB6
      } else if ((previous === HangulLV || previous === HangulV) && (current === HangulV || current === HangulT)) {
        breakHere = false; // GB7
      } else if ((previous === HangulLVT || previous === HangulT) && current === HangulT) {
        breakHere = false; // GB8
      } else if (current === Extend) {
        breakHere = false; // GB9 (Extend | ZWJ)
      } else if (current === SpacingMark) {
        breakHere = false; // GB9a
      } else if (previous === Prepend) {
        breakHere = false; // GB9b
      } else if (indicLinkerSeen && isIndicConsonant(cp)) {
        breakHere = false; // GB9c
      } else if (pictographicRun && previousCp === ZWJ && current === ExtendedPictographic) {
        breakHere = false; // GB11
      } else if (previous === RegionalIndicator && current === RegionalIndicator && regionalIndicatorRun % 2 === 1) {
        breakHere = false; // GB12 / GB13
      }

      if (breakHere) boundaries.push(index);
    }

    // Update run state for the rules that look further back than one character.
    if (current === RegionalIndicator) {
      regionalIndicatorRun += 1;
    } else {
      regionalIndicatorRun = 0;
    }

    if (current === ExtendedPictographic) {
      pictographicRun = true;
    } else if (current !== Extend) {
      pictographicRun = false;
    }

    if (INDIC_LINKERS.has(cp)) {
      indicLinkerSeen = true;
    } else if (current !== Extend || cp === ZWNJ) {
      indicLinkerSeen = false; // ZWNJ extends graphemes but is not an InCB=Extend character
    }

    previousCp = cp;
    previous = current;
    index += width;
  }

  boundaries.push(text.length);
  return boundaries;
}

let nativeSegmenter: Intl.Segmenter | null | undefined;

function getNativeSegmenter(): Intl.Segmenter | null {
  if (nativeSegmenter === undefined) {
    nativeSegmenter =
      typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  return nativeSegmenter;
}

/**
 * Boundary offsets (UTF-16 code-unit indices) of every grapheme cluster in
 * `text`, always starting with `0` and ending with `text.length`.
 */
export function graphemeBoundaries(text: string): number[] {
  const segmenter = getNativeSegmenter();
  if (segmenter === null) return fallbackBoundaries(text);
  const boundaries: number[] = [];
  for (const segment of segmenter.segment(text)) boundaries.push(segment.index);
  boundaries.push(text.length);
  return boundaries;
}

/** Iterates the grapheme clusters of `text`, in order. */
export function* segmentGraphemes(text: string): IterableIterator<string> {
  const segmenter = getNativeSegmenter();
  if (segmenter === null) {
    const boundaries = fallbackBoundaries(text);
    for (let i = 1; i < boundaries.length; i += 1) {
      yield text.slice(boundaries[i - 1], boundaries[i]);
    }
    return;
  }
  for (const segment of segmenter.segment(text)) yield segment.segment;
}
