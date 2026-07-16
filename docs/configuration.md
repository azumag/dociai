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
| `maxTokens` | 省略可。通常応答の最大出力トークン数。既定 2048、範囲 1〜32768 |
| `retries` | 省略可。既定 1。タイムアウトした場合のみ即座に再試行する回数 (認証エラー等はリトライしない) |

`mock` はAPIキーなしで応答・画面認識・ニュース要約の動作確認ができるモックです。

Ollama を使う場合は、Ollama を起動してモデルを pull したうえで `provider: "ollama"` を指定します。発話用ペルソナ、ニュース要約、`context.screenCapture.connector` の vision_model 参照先として同じように選べます。
Ollama の OpenAI 互換APIには `reasoning_effort: "none"` を自動指定し、thinking対応モデルでも内部思考ではなく最終回答に出力予算を使わせます。内部思考は応答や読み上げには使用しません。プロバイダが出力上限による終了を通知した場合は、システムログに「読み上げ処理による切断ではない」ことと `maxTokens` の確認案内を表示します。モデル側がthinking無効化に対応していない場合や、2048トークンを超える長文が必要な場合は設定画面の `maxTokens` を増やしてください。

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
- `voice.engine` — `webspeech` (既定, ブラウザ内蔵)、`voicevox`、`bouyomi` のいずれか
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

## bouyomi

棒読みちゃんの HTTP 連携 (issue #30)。棒読みちゃん側で「HTTP連携」を有効にし、
`commentReader.engine` または `personas[].voice.engine` に `"bouyomi"` を指定します。

```json
{
  "bouyomi": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:50080",
    "timeoutMs": 5000,
    "voice": 0,
    "volume": -1,
    "speed": -1,
    "tone": -1,
    "charsPerSecond": 6
  }
}
```

`voice` は 0 が棒読みちゃん側の既定話者、`volume` / `speed` / `tone` は -1 で
棒読みちゃん側の設定を使います。読み上げは `/Talk` に投入され、その後の順番は
棒読みちゃん自身のキューが管理します。「全消去」は `/Clear` にも送られます。
ブラウザ版で CORS に阻まれる場合は Electron 版を使うと、限定された preload API 経由で
メインプロセスからローカル HTTP API を呼び出せます。

`speed` は棒読みちゃんの speed パラメータで 50〜200 程度のスケール (既定 -1 は
棒読みちゃん本体の設定に従う) です。Web Speech の `commentReader.webspeech.rate`
(0.5〜2)、VOICEVOX の `commentReader.voicevox.speed` (0.5〜2) とは互換性がありません。
棒読みちゃんの速度を変えたい場合は `bouyomi.speed` または `personas[].voice.speed` /
`commentReader.bouyomi.speed` を個別に指定してください。

`/Talk` は投入した瞬間に応答が返る (実際の再生完了は通知されない) ため、`commentReader`
と `personas[].voice` で異なるエンジンを組み合わせている場合 (例: コメント読み上げは
`bouyomi`、AIペルソナは `voicevox`/`webspeech`)、文字数と `speed` から発話時間を見積もり、
その時間が経過するまで次のアイテムの再生を待たせることでコメント読み上げとAI読み上げの
音声が被らないようにしています。見積もりのため実際の発話時間とはずれる場合があります。
見積りの基準は `charsPerSecond` (既定 6、speed=100相当のとき1秒に読む文字数) で、
実際に使っている声の速さと見積りがずれていて待機が長すぎる/短すぎると感じる場合は
この値を調整してください (小さくすると見積り時間が延び、大きくすると縮みます)。

## 設定適用中の読み上げキュー

設定エディタの保存や設定ファイルの再読込では、実行中のランタイムを安全に切り替えます。
この切替だけでキューを全消去することはありません。再生中の項目は新しい音声backendで先頭から
再開し、待機中の項目は元の順序を保って引き継がれます。再開後の保留・再投入では通常のpriorityと
待機数上限が再び適用されます。

ペルソナまたはコメント読み上げのvoice設定を変更した場合、引き継いだ項目は新しいvoice設定で
再生します。マイク発話による一時保留は新しいマイク監視状態で判定し直しますが、手動の「停止」は
設定適用後も維持されます。キューを確実に破棄する操作は明示的な「全消去」のみです。

## micMonitor

マイク入力を監視し、配信者が発話している間はAI音声キューを保留、無音に戻ると
再開する (issue #32)。

```json
{
  "micMonitor": {
    "enabled": false,
    "threshold": 0.05,
    "minSpeechMs": 150,
    "silenceHoldMs": 800,
    "deviceId": null
  }
}
```

| フィールド | 既定 | 説明 |
|---|---|---|
| `enabled` | false | マイク監視機能を有効化 (操作卓の「監視開始」ボタンで手動起動する) |
| `threshold` | 0.05 | 発話とみなすRMS音量のしきい値 (0-1)。マイクのゲイン・部屋の暗騒音により調整が必要 |
| `minSpeechMs` | 150 | しきい値超えがこの時間継続したら「発話中」と判定するまでの継続時間 (ms) |
| `silenceHoldMs` | 800 | しきい値未満がこの時間継続したら「無音」と判定し読み上げを再開するまでの継続時間 (ms) |
| `deviceId` | null | 監視対象の入力デバイスの`MediaDeviceInfo.deviceId`。未指定 (null) の場合はOS/ブラウザの既定デバイスを使う。Electronにはブラウザのようなデバイス選択UIが無いため、設定パネルの「マイク監視」タブから明示的に選択する (issue #32) |

「発話中」判定になると `SpeechQueue.hold("mic")` が呼ばれます。**再生中の発話は中断せず
最後まで読み上げます** が、次に控えている項目の開始は保留されます。無音判定に戻ると
`SpeechQueue.release("mic")` が呼ばれ、保留していた次の項目の読み上げが始まります
(手動の「停止」ボタンとは異なり、マイク発話による保留は再生中の項目を巻き戻しません)。
しきい値の調整は操作卓の「マイク監視」パネルのメーター表示を見ながら行ってください。

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
    "webspeech": { "name": "default", "rate": 1.0, "pitch": 1.0 },
    "voicevox": { "speaker": 3, "speed": 1.0, "pitch": 0.0, "intonation": 1.0, "volume": 1.0 },
    "bouyomi": { "voice": 0, "speed": -1, "tone": -1, "volume": -1 },
    "includeAuthor": true,
    "skipEmotes": false,
    "collapseConsecutiveEmoji": false,
    "ignoreUsers": [],
    "intervalSeconds": 0
  }
}
```

| フィールド | 既定 | 説明 |
|---|---|---|
| `enabled` | false | コメント読み上げを有効化 |
| `engine` | webspeech | `webspeech` / `voicevox` / `bouyomi` (personas の `voice.engine` と同じ選択肢) |
| `intervalSeconds` | 0 | あるコメントの読み上げが終わってから次のコメントの読み上げを始めるまでの最短待機時間 (秒、0〜3600)。既定0では待機なしで次々読み上げる。コメント読み上げより後ろに積まれたAI応答も、この待機の間は自分の順番を待つ (同じ読み上げキューを使うため) |
| `webspeech` | `{ name: "default", rate: 1, pitch: 1 }` | Web Speech専用の音声名・速度・音高 |
| `voicevox` | `{ speed: 1, pitch: 0, intonation: 1, volume: 1 }` | VOICEVOX専用の話者ID (`speaker`)・速度・音高・抑揚・音量。`speaker` 省略時は共通の `voicevox.defaultSpeaker` を使用 |
| `bouyomi` | `{}` | 棒読みちゃん専用の話者・速度・音程・音量。省略した項目は共通の `bouyomi.voice` / `speed` / `tone` / `volume` を継承し、共通値の `-1` は本体設定に従う。待機時間が合わない場合は `speed` または `bouyomi.charsPerSecond` を調整する |
| `includeAuthor` | true | falseにすると「author: 本文」ではなく本文のみ読み上げる |
| `skipEmotes` | false | trueにするとTwitchのエモートを読み上げから除去する。Twitchが送るIRCの `emotes` タグ (エモートの正確な文字範囲) を使うため、手動入力コメントなど emotes 情報がないソースには影響しない |
| `collapseConsecutiveEmoji` | false | trueにすると連続するUnicode絵文字を先頭1つへまとめる。単独の絵文字は残し、絵文字間が空白だけの場合も連続として扱う。Twitchエモートの除去は `skipEmotes` で別に設定する |
| `ignoreUsers` | `[]` | このユーザー名 (大文字小文字区別なし、前後空白は無視) からのコメントは読み上げをスキップする。AI応答のトリガー判定自体には影響しない |

コメントは `AIConnector` を経由せずそのまま読み上げキューに積まれるため、APIキーなし
(モック接続すら不要) で動作する。AIペルソナがトリガーで応答する場合、同じキューに
「コメント読み上げ」→「AI応答」の順で積まれるため、視聴者のコメントとAIの返答を
両方音声で聞ける。読み上げに使うエンジンは `voicevox` / `webspeech` / `bouyomi`
から選べます。

3エンジンの音声設定は独立して保存されます。`engine`を切り替えても、別エンジンの
速度や音高を上書きしません。旧形式のフラットな`name` / `rate` / `pitch` / `speed`
なども読み込み時に対応するエンジン設定へ移されるため、既存configはそのまま利用できます。

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
| `commonRules` | (下記既定文言) | 全ペルソナの `systemPrompt` の後ろに `# 共通ルール` として自動で付加される指示文。空文字にすると何も付加されない。既定値は `src/config/config-defaults.js` の `DEFAULT_COMMON_RULES` (「音声読み上げ前提で2文以内」等) |
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
| `retry.maxAttempts` | 一時障害の最大試行回数。既定 `3` |
| `retry.initialDelaySeconds` | 最初の再試行までの待機秒数。既定 `30`。以降は指数バックオフ |
| `retry.maxDelaySeconds` | 再試行待機の上限秒数。既定 `900` |
| `style` | ニュースを読み上げるときの口調指示 |
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

## topics

`topics` は Todoist などから拾った配信ネタを、ニュースとは別のトリガー・別のペルソナで読み上げる設定です。

| フィールド | 説明 |
|---|---|
| `enabled` | 話題機能のON/OFF |
| `trigger` | 話題読み上げを起動するトリガーID |
| `persona` | 話題担当ペルソナID。省略時は `router.defaultPersona` |
| `sources` | `{ name, type: "todoist", token, projectId, enabled }` の配列 |
| `maxItems` | 1回の実行で読む最大件数 (既定 3) |
| `dedupe` | タイトル正規化による重複排除。既定 `true` |
| `retry.maxAttempts` | 一時障害の最大試行回数。既定 `3` |
| `retry.initialDelaySeconds` | 最初の再試行までの待機秒数。既定 `30` |
| `retry.maxDelaySeconds` | 再試行待機の上限秒数。既定 `900` |
| `intro` | 話題を読み上げるときの依頼文。既定は「上のお題について、あなたのキャラクターとして自由にコメントしてください。」 |
| `style` | 話題の口調指示。既定は「雑談のお題として、自然な自分の言葉で自由にコメントする」 |

### Todoistから話題を拾う

`topics.sources[].type: "todoist"` を使うと、Todoistの特定プロジェクトに入っている未完了タスクを
「話題」として拾い、AIがキャラクターとして自由にコメントする形で読み上げます。スマホの
Todoistアプリ・ウィジェット・共有シートから、思いついた話題をそのプロジェクトに追加するだけで
配信ネタとして拾われるようになります。

```json
{
  "topics": {
    "enabled": true,
    "trigger": "topics_every_15min",
    "persona": "partner_ai",
    "sources": [
      {
        "name": "配信ネタ (Todoist)",
        "type": "todoist",
        "token": "your_todoist_personal_api_token",
        "projectId": "your_todoist_project_id"
      }
    ]
  }
}
```

| フィールド | 説明 |
|---|---|
| `token` | Todoistの個人アクセストークン (Todoist設定 → 連携機能から取得。OAuthアプリ登録は不要) |
| `projectId` | 話題として拾うプロジェクトのID。無関係なタスクを拾わないよう専用プロジェクトの作成を推奨 |

読み上げに使えた話題は `POST /tasks/{id}/close` でTodoist側も完了にします。これによりブラウザの
セッション内(`readGuids`、リロードで消える)だけでなくTodoist側にも既読状態が残るため、
リロードや別端末でも同じ話題が繰り返し読み上げられません。AI生成が失敗した場合は完了にせず、
次回また拾い直されます。

Todoist由来の話題は `topics.intro`/`topics.style` を使って読み上げ文が組み立てられ、
プロンプトの見出しも「読み上げるニュース」ではなく「拾った話題」になります。

旧設定の `news.sources[].type: "todoist"` は読み込み時に `topics` へ移されますが、新しい設定では
`news` と `topics` を分けて書いてください。これにより、実ニュース(rss/mock)とTodoist話題を
別々の頻度・別々のペルソナで同時併走できます。

## EventTriggerのoverlay-cue

`eventTriggers.<id>.actions` では、発話Actionに加えて画像・音声を表す`overlay-cue`を保存できます。
保存設定にはasset registryの安全な`assetId`だけを書き、URL、絶対path、CSS、JavaScript、
`assetHandle`、`cueInstanceId`などのruntime値は書けません。未指定の表示・時間・transition・
競合policyは、simulationとproductionで共有する同じdefault関数によって実行時に展開されます。

```json
{
  "id": "reward-overlay",
  "kind": "overlay-cue",
  "priority": 10,
  "cue": {
    "visual": { "assetId": "reward-image", "x": 0.5, "y": 0.5, "fit": "contain" },
    "audio": { "assetId": "reward-sound", "volume": 0.8 },
    "timing": { "enterMs": 250, "holdMs": 2000, "exitMs": 250 },
    "transition": { "enter": "fade", "exit": "fade", "easing": "ease" },
    "policy": { "channel": "rewards", "mode": "queue", "maxQueue": 20 }
  }
}
```

`visual`と`audio`の少なくとも一方が必要です。保存形式と、asset metadata・opaque handle・
plan/event/trigger IDを含む`ResolvedOverlayCue`は分離されています。このcontract対応前の古いbuildは
`overlay-cue`を未知Actionとしてvalidation errorにし、そのActionだけを実行計画から除外します。
現buildでもrenderer runtimeが利用可能になるまでは、安全に`overlay-unavailable`としてskipします。

## Web調査 prepass (MiniMax)

`research.enabled`を有効にすると、コメント・手動依頼への通常回答、および話題（`topics`）の
読み上げコメント生成の前に、`research.connector`で指定したMiniMax connectorのWeb検索を実行します。
公式Token Plan Search API（`POST /v1/coding_plan/search`）を利用するため、契約や利用量に応じた
料金が発生する場合があります。

```json
{
  "research": {
    "enabled": true,
    "connector": "minimax_main",
    "maxResults": 5
  }
}
```

検索結果は外部の未検証資料として本回答のcontextへ渡されます。検索結果に含まれる命令は無視するよう
promptで明示し、最大10件に制限します。検索失敗時は検索なしの通常回答へフォールバックし、応答全体は
停止しません。ElectronではconnectorのAPI keyをMain process内だけで参照し、Rendererへ返しません。

## ニュース読み上げの参考: `azumag/soviet_now` 構造メモ (issue #10)

`soviet_now` はshellベースの配信ラジオ実装で、`broadcast/radio_news.sh` (585行) に
ニュース処理が集約されている。移植価値のあるパターン:

1. **AIスパム判定** — 読み上げ前にタイトル+本文冒頭をAIに渡し「SPAM / NEWS」の1語判定。宣伝・PR記事を除外する。タイムアウトや判定失敗時はPASS (読む側に倒す)
2. **タイトル正規化キーによる重複排除** — NFKC正規化 + 記号除去したタイトルをキーに、複数ソース間の同一ニュース再読を防ぐ (本PoCのguid管理より強い)
3. **トピックキー抽出** — タイトル先頭語から話題キーを作り、同一話題の連続読み上げを避ける
4. **AI生成キュー** — 同時にAI呼び出しが走らないようトークンで直列化 (本PoCでは `NewsReader.busy` が相当)

このうち 1 と 2 は `NewsReader` に追加しやすい (fetchAllの後段にフィルタを挟むだけ)。
