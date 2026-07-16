// コメントソースアダプタ (issue #11)
// 手動入力も実配信コメントも、同じインターフェースで CommentStore に流し込む。
//
// CommentSource インターフェース:
//   id: string                  — ソース識別子 (comment.source に入る)
//   label: string               — UI表示名
//   start(onComment): void      — onComment({ author, text, source }) を呼び始める
//   stop(): void                — 取得を止める
//
// YouTube Live Chat / Twitch IRC の実装方針は docs/comment-sources.md を参照。

import { parseIrcFrame } from "./twitch-chat/twitch-irc-parser.js";
export { TwitchChatSource } from "./twitch-chat/twitch-chat-source.js";

export class ManualCommentSource {
  id = "manual";
  label = "手動入力";

  start(onComment) {
    this.onComment = onComment;
  }

  stop() {
    this.onComment = null;
  }

  // UIの入力フォームから呼ぶ
  submit({ author, text }) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed || !this.onComment) return null;
    return this.onComment({
      author: String(author ?? "").trim() || "名無し",
      text: trimmed,
      source: this.id,
    });
  }
}

export function parseTwitchIrcLine(line) {
  const event = parseIrcFrame(line)[0];
  if (!event) return null;
  if (event.type === "ping") return { type: "ping", payload: event.payload };
  if (event.type !== "privmsg") return null;
  // "bits" tag (issue #177): see twitch-chat-session.js's identical forwarding for why.
  const bits = event.tags?.bits ? Number(event.tags.bits) : null;
  return { type: "message", author: event.author, text: event.text, channel: event.channel, ...(event.emotes ? { emotes: event.emotes } : {}), ...(bits ? { bits } : {}) };
}

// Twitchの emotes タグ ("id:start-end,start-end/id2:start-end") が指す文字範囲を
// 本文から取り除く。範囲はUTF-16コード単位・両端含む (Twitch IRC仕様)。
export function stripEmotes(text, emotesTag) {
  const s = String(text ?? "");
  if (!emotesTag) return s;
  const ranges = [];
  for (const part of String(emotesTag).split("/")) {
    const rangesStr = part.split(":")[1];
    if (!rangesStr) continue;
    for (const r of rangesStr.split(",")) {
      const [start, end] = r.split("-").map(Number);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) ranges.push([start, end]);
    }
  }
  if (!ranges.length) return s;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) out += s.slice(cursor, start);
    cursor = Math.max(cursor, end + 1);
  }
  out += s.slice(cursor);
  return out.replace(/\s+/g, " ").trim();
}

const emojiSegmenter = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
const pictographicEmoji = /\p{Extended_Pictographic}/u;
const emojiModifier = /^\p{Emoji_Modifier}$/u;
const consecutiveEmojiModifiers = /(\p{Emoji_Modifier})(?:\s*\p{Emoji_Modifier})+/gu;
const flagEmoji = /^\p{Regional_Indicator}{2}$/u;
const keycapEmoji = /^[#*0-9]\uFE0F?\u20E3$/u;

function isEmojiGrapheme(value) {
  return pictographicEmoji.test(value) || emojiModifier.test(value) || flagEmoji.test(value) || keycapEmoji.test(value);
}

// Unicode絵文字の連続を、読み上げ対象の先頭1個へまとめる。ZWJ/肌色/VS16を含む
// grapheme clusterはIntl.Segmenterで1絵文字として扱い、絵文字間の空白だけは連続扱いに
// する。一方で句読点や通常文字を挟む場合は別の絵文字として残す。
export function collapseConsecutiveEmojiRuns(text) {
  // Intl.Segmenterは不正な単独modifier列を直前の通常文字と同じgraphemeへ含めることが
  // あるため、modifierだけの連続はsegment分割より先に正規化する。
  const input = String(text ?? "").replace(consecutiveEmojiModifiers, "$1");
  if (!input || !emojiSegmenter) return input;
  const output = [];
  let emojiRun = false;
  let pendingWhitespace = "";
  for (const { segment } of emojiSegmenter.segment(input)) {
    if (/^\s+$/u.test(segment) && emojiRun) {
      pendingWhitespace += segment;
      continue;
    }
    if (isEmojiGrapheme(segment)) {
      if (!emojiRun) {
        output.push(segment);
        emojiRun = true;
      }
      pendingWhitespace = "";
      continue;
    }
    if (pendingWhitespace) output.push(pendingWhitespace);
    pendingWhitespace = "";
    output.push(segment);
    emojiRun = false;
  }
  if (pendingWhitespace) output.push(pendingWhitespace);
  return output.join("");
}

// 将来のYouTubeアダプタもこの形で追加する:
// export class YouTubeChatSource { id = "youtube"; start(onComment) { /* liveChatMessages polling */ } stop() {} }
