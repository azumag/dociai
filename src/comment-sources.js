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
  return { type: "message", author: event.author, text: event.text, channel: event.channel, ...(event.emotes ? { emotes: event.emotes } : {}) };
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

// 将来のYouTubeアダプタもこの形で追加する:
// export class YouTubeChatSource { id = "youtube"; start(onComment) { /* liveChatMessages polling */ } stop() {} }
