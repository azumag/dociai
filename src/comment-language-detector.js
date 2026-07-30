// コメント読み上げ翻訳 (issue #257) のローカル言語判定。完全にRenderer内・オフラインで完結する
// (外部APIへは一切送信しない)。日本語コメントは常にゼロIPCの高速パスを通る。
//
// tinyld (src/vendor/tinyld、issue #259でベンチマーク済み) を使う。
//
// 信頼度スコアの仕様に関する重要な注意 (issue #259のベンチマークで判明):
// tinyldのdetectAll()が返す`accuracy`は0〜1の確率ではない。正しいtop1判定でも0.16〜1.0まで
// 大きくばらつくため、`accuracy >= minimumConfidence`のような絶対しきい値比較は機能しない
// (絶対しきい値方式では70件コーパスで88.6%、issue本文の例文すら通らない誤検出を招いた)。
// 代わりにtop1とtop2の相対的な差 (shareスコア = top1 / (top1 + top2)) をminimumConfidenceと
// 比較する。この方式は同コーパスで94.3%まで改善し、誤った言語への翻訳(wrong language)は
// ゼロだった。`commentReader.translation.minimumConfidence`はこのshareスコアに対するしきい値
// として扱う (0.5 = top1とtop2が同点、1.0 = top2が実質ゼロ)。
import { detectAll } from "./vendor/tinyld/tinyld.normal.browser.js";

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;
const URL_RE = /https?:\/\/\S+/gi;
const MENTION_RE = /@\w+/g;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const LATIN_LETTER_RE = /[A-Za-zÀ-ÿ]/g;

// 短文・URL・絵文字・固有名詞だけのコメント (例: "GG", "LOL", ゲーム名) を誤訳しないための
// 最低ライン。issue #259のベンチマークコーパスでこの2条件が実際に有効だったしきい値。
const MIN_LATIN_LETTERS = 12;
const MIN_WORDS = 3;
// tinyldのtop1候補がほぼノイズ (1〜2文字の断片等) の場合の絶対フロア。shareスコアの分母が
// 意味を持たないほど小さい値を弾く。
const MIN_ABSOLUTE_SCORE = 0.05;

// text: 判定対象 (絵文字圧縮・emote除去は呼び出し側で先に適用済みの前提)
// sourceLanguages: 翻訳元として許可する言語 (例: ["en", "fr"])
// minimumConfidence: 上記のshareスコアしきい値 (0〜1)
// 戻り値: { language: "ja" | 一致したsourceLanguagesの要素 | null, confidence: number }
// language が null の場合は「原文のまま読み上げる」判定 (対象外言語・低信頼度・短文等)。
export function detectCommentLanguage(text, { sourceLanguages = ["en", "fr"], minimumConfidence = 0.7 } = {}) {
  const raw = String(text ?? "");
  if (CJK_RE.test(raw)) return { language: "ja", confidence: 1 };

  const stripped = raw.replace(URL_RE, "").replace(MENTION_RE, "").replace(EMOJI_RE, "").trim();
  const letters = (stripped.match(LATIN_LETTER_RE) ?? []).length;
  const words = stripped.split(/\s+/).filter(Boolean).length;
  if (letters < MIN_LATIN_LETTERS || words < MIN_WORDS) return { language: null, confidence: 0 };

  const candidates = detectAll(stripped);
  const top = candidates[0];
  if (!top || top.accuracy < MIN_ABSOLUTE_SCORE || !sourceLanguages.includes(top.lang)) {
    return { language: null, confidence: 0 };
  }

  const second = candidates[1];
  const share = second ? top.accuracy / (top.accuracy + second.accuracy) : 1;
  if (share < minimumConfidence) return { language: null, confidence: share };
  return { language: top.lang, confidence: share };
}
