// コメント読み上げ用の整形・翻訳要否判定 (issue #257 Phase 1, #260)。
// 旧 readCommentAloud() 内に直接あった処理を、テスト可能な純関数へ分離したもの。
// 翻訳の実行そのものはここでは行わない (非同期IO・timeoutはCommentSpeechPipelineの責務) —
// このモジュールは常に同期・副作用なしで完結する。
import { collapseConsecutiveEmojiRuns, collapseConsecutiveEmoteRuns, stripEmotes } from "./comment-sources.js";
import { detectCommentLanguage } from "./comment-language-detector.js";

// マーカー文字列以降を切り落とす (issue #254)。indexOf による大文字小文字区別ありのリテラル
// 部分文字列一致のみ — 正規表現は使わない。marker が空文字/未設定なら何もしない ("".indexOf("")
// は常に0を返すため、ここで弾かないと excludeAfterMarker: "" (無効化の既定値) が全文を
// 切り落としてしまう)。
function truncateAtMarker(text, marker) {
  if (!marker) return text;
  const index = text.indexOf(marker);
  if (index === -1) return text;
  return text.slice(0, index).trimEnd();
}

// 戻り値:
//   { kind: "skip", reason }
//   { kind: "speak", originalText, translated: false, detectedLanguage? }
//   { kind: "translate", originalText, detectedLanguage, confidence }
export function processCommentForSpeech(comment, commentReader) {
  const cr = commentReader ?? {};
  if (!cr.enabled) return { kind: "skip", reason: "disabled" };
  if ((cr.ignoreUsers ?? []).some((user) => String(user).trim().toLowerCase() === comment.author.toLowerCase())) {
    return { kind: "skip", reason: "ignored-user" };
  }

  // マーカー切り出しは一番先に行う。stripEmotes/collapseConsecutiveEmoteRunsはcomment.text
  // 基準の絶対位置でTwitchエモート範囲を解決するが、末尾を削るだけの切り出しなら残る前半部分の
  // 文字位置は元のcomment.textと変わらないため、後段のエモート処理はそのまま正しく動く
  // (末尾側の範囲は自動的に対象外になる)。先に行うことで、マーカー自体が実在のエモートコードと
  // 一致する場合や、マーカーに連続空白/連続絵文字を含む場合でも、stripEmotes等の副作用
  // (空白正規化・絵文字連投まとめ) に切り出し前のマーカー文字列を壊されずに済む。
  let body = truncateAtMarker(comment.text, cr.excludeAfterMarker);
  if (cr.skipEmotes && comment.emotes) {
    body = stripEmotes(body, comment.emotes);
  } else if (cr.collapseConsecutiveEmoji && comment.emotes) {
    body = collapseConsecutiveEmoteRuns(body, comment.emotes);
  }
  if (cr.collapseConsecutiveEmoji) body = collapseConsecutiveEmojiRuns(body);
  if (!body.trim()) return { kind: "skip", reason: "empty" };

  const translation = cr.translation;
  if (!translation?.enabled) return { kind: "speak", originalText: body, translated: false };

  const maxInputChars = Math.max(1, Number(translation.maxInputChars) || 500);
  if (body.length > maxInputChars) return { kind: "speak", originalText: body, translated: false };

  const { language, confidence } = detectCommentLanguage(body, {
    sourceLanguages: translation.sourceLanguages,
    minimumConfidence: translation.minimumConfidence,
  });
  // 日本語コメント・対象外言語・低信頼度コメントは原則翻訳しない (issue #257要件)。
  if (!language || language === "ja") {
    return { kind: "speak", originalText: body, translated: false, ...(language ? { detectedLanguage: language } : {}) };
  }

  return { kind: "translate", originalText: body, detectedLanguage: language, confidence };
}
