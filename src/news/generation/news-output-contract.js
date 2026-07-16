// ニュース生成の構造化出力契約 (issue #191)。
// LLMにはJSON onlyを要求せず、marker区切りのプレーンテキストを要求する。parserは
// src/news/quality/news-output-parser.js (issue #192) が持ち、ここではmarker定数と
// prompt向けの指示文だけを正典として定義する。

export const NEWS_OUTPUT_MARKERS = Object.freeze({
  TITLE: "===TITLE===",
  BODY: "===BODY===",
  SUMMARY: "===SUMMARY===",
  ENTITIES: "===ENTITIES===",
  SOURCE_IDS: "===SOURCE_IDS===",
});

export const NEWS_OUTPUT_MARKER_ORDER = Object.freeze([
  NEWS_OUTPUT_MARKERS.TITLE,
  NEWS_OUTPUT_MARKERS.BODY,
  NEWS_OUTPUT_MARKERS.SUMMARY,
  NEWS_OUTPUT_MARKERS.ENTITIES,
  NEWS_OUTPUT_MARKERS.SOURCE_IDS,
]);

// LLMへ渡す出力形式の指示文そのもの。marker欠落時のfallbackはparser側(#192)の責務であり、
// ここは「何を出力してほしいか」だけを固定する。
export function buildOutputFormatInstructions() {
  return [
    "出力は次の形式に厳密に従ってください。marker行はそのまま、他の文字を混ぜないでください。",
    NEWS_OUTPUT_MARKERS.TITLE,
    "(読み上げ用タイトルを1行)",
    NEWS_OUTPUT_MARKERS.BODY,
    "(読み上げ本文。プレーンテキストの話し言葉のみ)",
    NEWS_OUTPUT_MARKERS.SUMMARY,
    "(30〜80文字の要約を1行)",
    NEWS_OUTPUT_MARKERS.ENTITIES,
    "(本文に登場する固有名詞を1行1件。無ければ「なし」)",
    NEWS_OUTPUT_MARKERS.SOURCE_IDS,
    "(参照した根拠のsource idを1行1件。根拠が無ければ「なし」。URLそのものは書かない)",
  ].join("\n");
}
