// コメント読み上げ用の整形・翻訳要否判定 (issue #257 Phase 1, #260)。
// 旧 readCommentAloud() 内に直接あった処理を、テスト可能な純関数へ分離したもの。
// 翻訳の実行そのものはここでは行わない (非同期IO・timeoutはCommentSpeechPipelineの責務) —
// このモジュールは常に同期・副作用なしで完結する。
import { collapseConsecutiveEmojiRuns, stripEmotes } from "./comment-sources.js";
import { detectCommentLanguage } from "./comment-language-detector.js";

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

  let body = cr.skipEmotes && comment.emotes ? stripEmotes(comment.text, comment.emotes) : comment.text;
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
