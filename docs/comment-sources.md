# コメントソースアダプタ設計 (issue #11)

## インターフェース

手動入力も実配信コメントも、同じ形で `CommentStore` に流し込む。実装は `src/comment-sources.js`。

```js
// CommentSource
{
  id: string,                 // comment.source に入る識別子 ("manual" | "youtube" | "twitch")
  label: string,              // UI表示名
  start(onComment) {},        // onComment({ author, text, source }) を呼び始める
  stop() {},                  // 取得を止める
}
```

`src/app/runtime-factory.js` 側は `source.start((raw) => addComment(raw))` と接続するだけで、トリガー判定・ペルソナ応答は共通フローに乗る。現在は `ManualCommentSource` と `TwitchChatSource` を実装済み。

## YouTube Live Chat 取得方式の調査

| 方式 | 概要 | 認証 | 制約 |
|---|---|---|---|
| YouTube Data API v3 `liveChatMessages.list` | 公式。`videos.list` で `activeLiveChatId` を取得し、`liveChatMessages.list` をポーリング | APIキー (読み取りのみなら十分。自分の限定配信はOAuth必須) | クォータ消費が大きい (デフォルト10,000units/日。1回の取得で数units、`pollingIntervalMillis` 指示に従う必要あり)。長時間配信では枯渇しがち |
| Innertube (非公式、pytchat等が使う方式) | 視聴ページと同じ内部APIを叩く | 不要 | 非公式のため仕様変更で突然壊れる。利用規約上グレー |

**推奨方針**: まず公式 Data API v3 (APIキーのみ) でPoCを作り、クォータが問題になったら間隔を伸ばすかInnertube系の併用を検討する。APIキーは既存の `config.local.json` の仕組みに `sources` 設定として追加する。

必要な実装 (ブラウザから直接叩ける。CORS対応済みAPI):

1. `GET videos?part=liveStreamingDetails&id={videoId}&key={apiKey}` → `activeLiveChatId`
2. `GET liveChatMessages?liveChatId=...&part=snippet,authorDetails&key={apiKey}` をポーリング
3. レスポンスの `pollingIntervalMillis` を次回間隔に使う
4. `nextPageToken` で差分取得し、`onComment({ author: authorDetails.displayName, text: snippet.displayMessage, source: "youtube" })`

## Twitch Chat 取得方式の調査

| 方式 | 概要 | 認証 | 制約 |
|---|---|---|---|
| IRC over WebSocket (`wss://irc-ws.chat.twitch.tv:443`) | チャットの実体はIRC。WebSocketで直接受信できる | **読み取り専用なら匿名可** (`NICK justinfan<数字>` で接続、OAuth不要) | 送信はできない。IRCメッセージのパースが必要 |
| EventSub WebSocket (`channel.chat.message`) | 新しい公式イベント配信 | OAuthユーザートークン + `user:read:chat` スコープ必須 | トークン管理が必要。PoCには重い |

**推奨方針**: 匿名IRC (justinfan) 方式が認証ゼロ・ブラウザのWebSocketだけで動くため、実コメント連携の最初の実装に最適。

実装済みの流れ:

1. `new WebSocket("wss://irc-ws.chat.twitch.tv:443")`
2. `NICK justinfan12345` → `JOIN #channelname`
3. `PRIVMSG` 行をパースして `onComment({ author, text, source: "twitch" })`
4. `PING` に `PONG` を返す

設定例:

```json
{
  "commentSources": {
    "twitch": {
      "enabled": true,
      "channels": ["your_twitch_channel"]
    }
  }
}
```

## 認証方式と必要権限の整理

| ソース | 読み取りに必要なもの | 保存場所 |
|---|---|---|
| 手動入力 | なし | — |
| Twitch (匿名IRC) | なし | — |
| YouTube (Data API) | APIキー (公開配信) / OAuth (自分の限定配信) | `config.local.json` (メモリ保持のみ、issue #13 と同じ扱い) |
| Twitch (EventSub) | OAuthユーザートークン + `user:read:chat` | 将来のローカル常駐アプリでOS資格情報ストアへ |

## 実装順の提案

1. Twitch 匿名IRCアダプタ (実装済み)
2. YouTube Data API アダプタ (APIキーのみ)
3. OAuthが要るケース (限定配信・送信) はローカル常駐アプリ化と同時に検討
