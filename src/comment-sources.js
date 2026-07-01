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

// 将来のYouTube/Twitchアダプタもこの形で追加する:
// export class TwitchChatSource { id = "twitch"; start(onComment) { /* IRC over WebSocket */ } stop() {} }
// export class YouTubeChatSource { id = "youtube"; start(onComment) { /* liveChatMessages polling */ } stop() {} }
