/**
 * Conservative language detection for the translation pipeline.
 *
 * A chunk already written in the target language needs no translation:
 * skipping it saves a provider round trip. Detection is deliberately
 * explicit and threshold-based — only well-known target scripts are
 * recognized, the ratios are strict, and anything uncertain returns false so
 * a chunk is always sent to the provider rather than silently left
 * untranslated. Placeholder tokens (⟪n⟫) and digits count for nothing: only
 * Unicode letters enter the ratios.
 */

// CJK unified ideographs (incl. Extension A and compatibility ideographs).
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
// Hiragana, katakana, and katakana phonetic extensions.
const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff]/g;
// Hangul jamo, compatibility jamo, and syllables.
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/g;
// Basic Latin plus Latin-1 / Extended-A / Extended-B letter ranges.
const LATIN_RE = /[A-Za-z\u00c0-\u024f]/g;
// Every Unicode letter, whatever the script: the ratio's denominator.
const LETTER_RE = /\p{L}/gu;

/** Latin-script European language names, matched case-insensitively. */
const LATIN_TARGET_NAMES = [
  "english",
  "英语",
  "英文",
  "french",
  "français",
  "francais",
  "german",
  "deutsch",
  "spanish",
  "español",
  "espanol",
  "portuguese",
  "português",
  "portugues",
  "italian",
  "italiano",
  "dutch",
  "nederlands",
  "polish",
  "polski",
  "swedish",
  "svenska",
  "danish",
  "dansk",
  "norwegian",
  "norsk",
  "finnish",
  "suomi",
  "czech",
  "čeština",
  "hungarian",
  "magyar",
  "romanian",
  "română",
  "turkish",
  "türkçe",
  "turkce",
  "croatian",
  "hrvatski",
  "slovenian",
  "slovenščina",
  "slovenscina",
  "slovak",
  "vietnamese",
  "tiếng việt",
  "tieng viet",
  "indonesian",
  "bahasa indonesia",
  "malay",
  "bahasa melayu",
] as const;

/** Integer arithmetic so boundary ratios (e.g. exactly 70%) are exact. */
const atLeastPercent = (part: number, total: number, percent: number): boolean =>
  part * 100 >= total * percent;

const countMatches = (text: string, re: RegExp): number =>
  (text.match(re) ?? []).length;

/**
 * Returns true when `text` is very likely already written in
 * `targetLanguage`, so the caller can skip sending it to the provider.
 * Recognized targets map to strict script-ratio rules; anything else returns
 * false. The ratios lean conservative (70-95%), and mixed-script text below
 * the bar is translated rather than skipped.
 */
export function isLikelyTargetLanguage(
  text: string,
  targetLanguage: string,
): boolean {
  const target = targetLanguage.toLowerCase().trim();
  const totalLetters = countMatches(text, LETTER_RE);
  if (totalLetters === 0) return false;

  const cjk = countMatches(text, CJK_RE);
  const kana = countMatches(text, KANA_RE);
  const hangul = countMatches(text, HANGUL_RE);
  const latin = countMatches(text, LATIN_RE);

  if (target.includes("中") || target.includes("汉语") || target.includes("chinese")) {
    return atLeastPercent(cjk, totalLetters, 70);
  }
  if (target.includes("日") || target.includes("japanese")) {
    // Kanji-only Japanese is indistinguishable from Chinese: require kana
    // before treating CJK-heavy text as Japanese.
    return kana > 0 && atLeastPercent(cjk + kana, totalLetters, 70);
  }
  if (
    target.includes("韩") ||
    target.includes("한국어") ||
    target.includes("조선어") ||
    target.includes("korean")
  ) {
    return atLeastPercent(hangul, totalLetters, 70);
  }
  if (LATIN_TARGET_NAMES.some((name) => target.includes(name))) {
    return atLeastPercent(latin, totalLetters, 95);
  }
  return false;
}