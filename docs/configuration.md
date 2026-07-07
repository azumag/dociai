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
| `provider` | `openai` / `openrouter` / `openai-compatible` / `ollama` / `minimax` / `mock` |
| `apiKey` | APIキー。`mock` / `ollama` では不要 |
| `model` | モデルID。`mock` では省略可 |
| `baseUrl` | 省略可。ローカルLLM やOpenAI互換サーバーを指す。`ollama` の既定は `http://localhost:11434/v1` |
| `timeoutMs` | 省略可。既定 30000 (ミリ秒。秒ではない点に注意) |
| `retries` | 省略可。既定 1。タイムアウトした場合のみ即座に再試行する回数 (認証エラー等はリトライしない) |

`mock` はAPIキーなしで応答・画面認識・ニュース要約の動作確認ができるモックです。

Ollama を使う場合は、Ollama を起動してモデルを pull したうえで `provider: "ollama"` を指定します。発話用ペルソナ、ニュース要約、`context.screenCapture.connector` の vision_model 参照先として同じように選べます。

```json
{
  "connectors": {
    "ollama_local": {
      "provider": "ollama",
      "model": "llama3.2",
      "baseUrl": "http://localhost:11434/v1"
    }
  }
}
```

MiniMax 公式の Anthropic Messages 互換APIを使う場合は `provider: "minimax"` を指定します。既定の `baseUrl` は `https://api.minimax.io/anthropic` です。

```json
{
  "connectors": {
    "minimax_main": {
      "provider": "minimax",
      "apiKey": "sk-...",
      "model": "MiniMax-M3"
    }
  }
}
```

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
- `voice.engine` — `webspeech` (既定, ブラウザ内蔵) または `voicevox` (issue #17)
- `voice.name` — Web Speech APIの音声名。`default` なら日本語音声を自動選択
- `voice.speaker` — VOICEVOX の話者ID (数値)。`/speakers` の style id。省略時は `voicevox.defaultSpeaker`
- `voice.speed` / `voice.pitch` / `voice.intonation` / `voice.volume` — VOICEVOX の各 Scale (soviet_now 互換)。`pitch` は現在の pitchScale に加算、それ以外は上書き
- `voice.rate` / `voice.pitch` — Web Speech API 用 (1.0 基準)。`engine: voicevox` のときは無視される
- `voice.enabled: false` — 応答はログに出すが読み上げない

## voicevox

VOICEVOX engine を使った音声合成 (issue #17)。ローカル Docker でもリモートホストでも可。

```json
{
  "voicevox": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:50021",
    "defaultSpeaker": 3,
    "maxChars": 200,
    "timeoutMs": 30000,
    "retries": 1
  }
}
```

| フィールド | 既定 | 説明 |
|---|---|---|
| `enabled` | false | VOICEVOX を有効化。`personas[].voice.engine: "voicevox"` のペルソナが使う |
| `baseUrl` | `http://127.0.0.1:50021` | engine の URL。例: `http://192.168.11.13:50021` |
| `defaultSpeaker` | 3 | ペルソナが `voice.speaker` を省略したときの話者ID (3 = ずんだもん ノーマル) |
| `maxChars` | 200 | 長文をチャンクに分ける際の1チャンク上限文字数 (soviet_now 互換) |
| `timeoutMs` | 30000 | 1チャンク合成のタイムアウト |
| `retries` | 1 | 1チャンクの合成がタイムアウトした場合のみ即座に再試行する回数 |

実装は `azumag/soviet_now/voicevox_tts.sh` をブラウザ向けに移植したものです。
長文は句点(`。`)・読点(`、`)・改行で `maxChars` を超えないように分割し、
各チャンクを `audio_query` → `synthesis` の2段階で合成して再生します。
チャンク[i]の再生中にチャンク[i+1]の合成を並走させる (1つ先読み) ため、
長文でも最初の音が出るまでの待ち時間はチャンク1個分の合成時間で済みます。
`pitch` はクエリの `pitchScale` に加算、`speed` / `intonation` / `volume` は上書きします。

CORS: engine は既定 (`--cors_policy_mode localrequests`) で Origin を見て
`Access-Control-Allow-Origin` を返します。`http://localhost:8080` からのリクエストは
そのまま通るので追加設定不要です。別ホストに置く場合は engine 側で
`--cors_policy_mode all` を指定してください。

## micMonitor

マイク入力を監視し、配信者が発話している間はAI音声キューを保留、無音に戻ると
再開する (issue #32)。

```json
{
  "micMonitor": {
    "enabled": false,
    "threshold": 0.05,
    "minSpeechMs": 150,
    "silenceHoldMs": 800
  }
}
```

| フィールド | 既定 | 説明 |
|---|---|---|
| `enabled` | false | マイク監視機能を有効化 (操作卓の「監視開始」ボタンで手動起動する) |
| `threshold` | 0.05 | 発話とみなすRMS音量のしきい値 (0-1)。マイクのゲイン・部屋の暗騒音により調整が必要 |
| `minSpeechMs` | 150 | しきい値超えがこの時間継続したら「発話中」と判定するまでの継続時間 (ms) |
| `silenceHoldMs` | 800 | しきい値未満がこの時間継続したら「無音」と判定し読み上げを再開するまでの継続時間 (ms) |

「発話中」判定になると `SpeechQueue.stop()` が呼ばれ、再生中の発話は中断されて
**保留 (waiting) に戻ります** (手動の「停止」ボタンと同じ挙動)。無音判定に戻ると
`SpeechQueue.resume()` が呼ばれ、中断された発話は最初から読み上げ直されます。しきい値の
調整は操作卓の「マイク監視」パネルのメーター表示を見ながら行ってください。

スピーカーで音声を再生している環境では、AI自身の声がマイクに回り込んで誤検知する
可能性があります。`echoCancellation`/`noiseSuppression` は既定で有効にしていますが、
最も確実な対策は `docs/obs-mode.md` の「音声出力先の扱い」で触れている
ヘッドホンや仮想オーディオデバイスでの分離です。

## commentReader

Twitch等に投稿された全コメントを、AIペルソナの応答とは独立にそのまま読み上げる
(issue #31)。トリガー条件やAI応答の有無に関わらず、届いたコメント全てが対象。

```json
{
  "commentReader": {
    "enabled": false,
    "engine": "webspeech",
    "name": "default",
    "rate": 1.0,
    "pitch": 1.0,
    "includeAuthor": true,
    "skipEmotes": false,
    "ignoreUsers": []
  }
}
```

| フィールド | 既定 | 説明 |
|---|---|---|
| `enabled` | false | コメント読み上げを有効化 |
| `engine` | webspeech | `webspeech` または `voicevox` (personas の `voice.engine` と同じ選択肢) |
| `name` | default | webspeech使用時の音声名。省略時は日本語音声を自動選択 |
| `rate` / `pitch` | 1.0 / 1.0 | 読み上げ速度・音高 |
| `speaker` | (voicevox.defaultSpeakerを使用) | voicevox使用時の話者ID。省略可 |
| `includeAuthor` | true | falseにすると「author: 本文」ではなく本文のみ読み上げる |
| `skipEmotes` | false | trueにするとTwitchのエモートを読み上げから除去する。Twitchが送るIRCの `emotes` タグ (エモートの正確な文字範囲) を使うため、手動入力コメントなど emotes 情報がないソースには影響しない |
| `ignoreUsers` | `[]` | このユーザー名 (大文字小文字区別なし、前後空白は無視) からのコメントは読み上げをスキップする。AI応答のトリガー判定自体には影響しない |

コメントは `AIConnector` を経由せずそのまま読み上げキューに積まれるため、APIキーなし
(モック接続すら不要) で動作する。AIペルソナがトリガーで応答する場合、同じキューに
「コメント読み上げ」→「AI応答」の順で積まれるため、視聴者のコメントとAIの返答を
両方音声で聞ける。読み上げに使うエンジンは `voicevox`/`webspeech` のいずれも選べ、
将来 issue #30 (棒読みちゃん連携) が入った場合はここに `engine: "bouyomi"` 相当の
選択肢が追加される想定。

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
| `screenCapture.maxTokens` | 768 | 画面説明生成に使う最大出力トークン数。thinking系vision modelでは大きめを推奨 |

## commentSources

手動入力は常に使えます。Twitch チャットを読む場合は `commentSources.twitch` を有効にします。

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

| フィールド | 既定 | 説明 |
|---|---|---|
| `twitch.enabled` | false | Twitch 匿名IRC WebSocketを開始する |
| `twitch.channels` | [] | 読み取るチャンネル名。`#` は付けても省略しても可 |
| `twitch.nick` | `justinfan...` | 省略可。匿名読み取り用ニックネーム |
| `twitch.url` | `wss://irc-ws.chat.twitch.tv:443` | 省略可。通常は変更不要 |

Twitch は読み取り専用なら OAuth 不要です。受信したコメントは手動入力と同じ `CommentStore` に入り、キーワード・ランダムなど既存トリガーの対象になります。

## news

| フィールド | 説明 |
|---|---|
| `enabled` | ニュース機能のON/OFF |
| `trigger` | 読み上げを起動するトリガーID (通常 `interval`) |
| `persona` | 読み上げ担当ペルソナID。省略時は `router.defaultPersona` |
| `mode` | `topic` / `current` / `simple`。既定 `topic` |
| `sources` | `{ name, type: "rss" \| "mock", url, enabled }` の配列。`mock` はテスト用。`enabled: false` で一時停止 |
| `maxItems` | 1回の実行で読む最大件数 (既定 3) |
| `dedupe` | タイトル正規化による重複排除。既定 `true` |
| `style` | 要約の口調指示 |
| `corsProxy` | 省略可。RSSがCORSで取れない場合のプロキシプレフィックス (例: `https://corsproxy.io/?url=`)。URLはこの後ろにencodeURIComponentで連結される |

RSS取得はブラウザから直接fetchするため、CORSヘッダのないフィード (NHK等) は
`corsProxy` を設定するか、CORS対応のフィードを使ってください。

ニュースソースは配列で自由に増減できます。RSS/Atom の `pubDate` / `published` / `updated` がある場合は新しい順に並び、同じ見出しは NFKC 正規化と記号除去後のキーで重複排除されます。

`mode` は読み上げの立ち位置を切り替えます。

| mode | 動作 |
|---|---|
| `topic` | 現状の配信トピックとして自然に紹介する |
| `current` | 背景や意味を深掘りし、短い独自考察を添える |
| `simple` | 独自考察や推測を足さず、提示された事実だけを伝える |

## ニュース読み上げの参考: `azumag/soviet_now` 構造メモ (issue #10)

`soviet_now` はshellベースの配信ラジオ実装で、`broadcast/radio_news.sh` (585行) に
ニュース処理が集約されている。移植価値のあるパターン:

1. **AIスパム判定** — 読み上げ前にタイトル+本文冒頭をAIに渡し「SPAM / NEWS」の1語判定。宣伝・PR記事を除外する。タイムアウトや判定失敗時はPASS (読む側に倒す)
2. **タイトル正規化キーによる重複排除** — NFKC正規化 + 記号除去したタイトルをキーに、複数ソース間の同一ニュース再読を防ぐ (本PoCのguid管理より強い)
3. **トピックキー抽出** — タイトル先頭語から話題キーを作り、同一話題の連続読み上げを避ける
4. **AI生成キュー** — 同時にAI呼び出しが走らないようトークンで直列化 (本PoCでは `NewsReader.busy` が相当)

このうち 1 と 2 は `NewsReader` に追加しやすい (fetchAllの後段にフィルタを挟むだけ)。
