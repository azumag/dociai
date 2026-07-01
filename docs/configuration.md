# Configuration

## `config.local.json`

ローカルPoCでは、APIキーやモデル設定を `config.local.json` に置きます。このファイルはGit管理しません。
`config.local.example.json` をコピーして作成し、操作卓の「サーバーから読込」(同じディレクトリの
`config.local.json` をfetch) か「ファイルを選択」で読み込みます。読み込んだ内容はメモリ保持のみです。

## connectors

ペルソナはAPIキーを直接持たず、`connector` IDを参照します。

```json
{
  "connectors": {
    "openai_main": {
      "provider": "openai",
      "apiKey": "sk-...",
      "model": "gpt-4.1-mini"
    }
  }
}
```

| フィールド | 説明 |
|---|---|
| `provider` | `openai` / `openrouter` / `openai-compatible` / `mock` |
| `apiKey` | APIキー。`mock` では不要 |
| `model` | モデルID。`mock` では省略可 |
| `baseUrl` | 省略可。ローカルLLM (例: `http://localhost:11434/v1`) やOpenAI互換サーバーを指す |
| `timeoutMs` | 省略可。既定 30000 |

`mock` はAPIキーなしで応答・画面認識・ニュース要約の動作確認ができるモックです。

## personas

```json
{
  "personas": [
    {
      "id": "partner_ai",
      "name": "相棒AI",
      "connector": "openai_main",
      "enabled": true,
      "systemPrompt": "あなたは配信者の相棒AIです。短く自然に返答します。",
      "triggers": ["mention_ai", "hotkey_partner"],
      "voice": { "enabled": true, "name": "default", "rate": 1.1, "pitch": 1.0 }
    }
  ]
}
```

- `triggers` — このペルソナが反応するトリガーIDの配列
- `voice.name` — Web Speech APIの音声名。`default` なら日本語音声を自動選択
- `voice.enabled: false` — 応答はログに出すが読み上げない

## triggers

| type | フィールド | 動作 |
|---|---|---|
| `keyword` | `keywords: []` | コメントにいずれかの語が含まれると発火 |
| `hotkey` | `keys: "Alt+1"` | ショートカットキーで発火 |
| `interval` | `minutes` / `seconds` | 一定時間ごとに発火 |
| `random` | `probability: 0.2` | コメントごとに確率で発火 |
| `manual` | — | UIボタンからのみ発火 |

## router

| フィールド | 既定 | 説明 |
|---|---|---|
| `defaultPersona` | 先頭ペルソナ | ニュース読み上げ等のフォールバック担当 |
| `maxRepliesPerComment` | 1 | 1コメントに応答できる最大ペルソナ数 |
| `cooldownSeconds` | 8 | 同一ペルソナの連続応答を抑える秒数 (手動発火は無視) |

## context

| フィールド | 既定 | 説明 |
|---|---|---|
| `commentHistoryLimit` | 80 | 保持する生コメント数 (リングバッファ) |
| `includeRecentComments` | 20 | プロンプトに入れる直近コメント数 |
| `maxPromptChars` | 4000 | プロンプト全体の文字数上限。超えると履歴を古い側から削る |
| `screenCapture.enabled` | false | 画面キャプチャ文脈のON/OFF |
| `screenCapture.connector` | — | 画面説明に使うVision対応コネクタID |
| `screenCapture.maxAgeSeconds` | 120 | これより古い画面説明はプロンプトに入れない |

## news

| フィールド | 説明 |
|---|---|
| `enabled` | ニュース機能のON/OFF |
| `trigger` | 読み上げを起動するトリガーID (通常 `interval`) |
| `persona` | 読み上げ担当ペルソナID。省略時は `router.defaultPersona` |
| `sources` | `{ name, type: "rss" \| "mock", url }` の配列。`mock` はテスト用 |
| `maxItems` | 1回の実行で読む最大件数 (既定 3) |
| `style` | 要約の口調指示 |
| `corsProxy` | 省略可。RSSがCORSで取れない場合のプロキシプレフィックス (例: `https://corsproxy.io/?url=`)。URLはこの後ろにencodeURIComponentで連結される |

RSS取得はブラウザから直接fetchするため、CORSヘッダのないフィード (NHK等) は
`corsProxy` を設定するか、CORS対応のフィードを使ってください。

## ニュース読み上げの参考: `azumag/soviet_now` 構造メモ (issue #10)

`soviet_now` はshellベースの配信ラジオ実装で、`broadcast/radio_news.sh` (585行) に
ニュース処理が集約されている。移植価値のあるパターン:

1. **AIスパム判定** — 読み上げ前にタイトル+本文冒頭をAIに渡し「SPAM / NEWS」の1語判定。宣伝・PR記事を除外する。タイムアウトや判定失敗時はPASS (読む側に倒す)
2. **タイトル正規化キーによる重複排除** — NFKC正規化 + 記号除去したタイトルをキーに、複数ソース間の同一ニュース再読を防ぐ (本PoCのguid管理より強い)
3. **トピックキー抽出** — タイトル先頭語から話題キーを作り、同一話題の連続読み上げを避ける
4. **AI生成キュー** — 同時にAI呼び出しが走らないようトークンで直列化 (本PoCでは `NewsReader.busy` が相当)

このうち 1 と 2 は `NewsReader` に追加しやすい (fetchAllの後段にフィルタを挟むだけ)。
