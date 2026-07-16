// LanguageDetector (issue #192): 日本語かな/CJK比率、漢字のみ文の連続 (中国語らしさ)、
// 長い英語segmentを検査する。title/body/summaryは呼び出し側が別々に判定する。

function isHiraganaOrKatakana(ch) {
  const code = ch.codePointAt(0);
  return code >= 0x3040 && code <= 0x30ff;
}

function isCjkIdeograph(ch) {
  const code = ch.codePointAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) || isHiraganaOrKatakana(ch);
}

export function analyzeLanguage(text) {
  const failures = [];
  const chars = [...text].filter((ch) => !/\s/.test(ch));
  const cjkCount = chars.filter(isCjkIdeograph).length;
  const japaneseRatio = chars.length ? cjkCount / chars.length : 1;
  if (chars.length >= 20 && japaneseRatio < 0.3) failures.push({ code: "low_japanese_ratio", severity: "rewrite", detail: japaneseRatio.toFixed(2) });

  // かなが全く無い長めの漢字連続文は中国語らしいsegmentとみなすheuristic。短い外国語固有名詞の
  // 混在 (人名・地名等) は許容するため、閾値をある程度大きくとる。
  const sentences = text.split(/(?<=[。！？!?.])\s*/).filter(Boolean);
  for (const sentence of sentences) {
    const sChars = [...sentence].filter((ch) => !/\s/.test(ch));
    const sCjk = sChars.filter(isCjkIdeograph).length;
    const sKana = sChars.filter(isHiraganaOrKatakana).length;
    if (sChars.length >= 12 && sCjk >= sChars.length * 0.6 && sKana === 0) {
      failures.push({ code: "kanji_only_sentence", severity: "warning", detail: sentence.slice(0, 40) });
    }
  }

  const englishRuns = text.match(/[A-Za-z][A-Za-z\s]{29,}/g) ?? [];
  for (const run of englishRuns) failures.push({ code: "long_english_segment", severity: "rewrite", detail: run.trim().slice(0, 40) });

  return { japaneseRatio, failures };
}
