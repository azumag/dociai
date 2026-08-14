# 英語クローズドキャプション (issue #282)

配信者の日本語のマイク音声を、デスクトップ版Google ChromeのWeb Speech APIで日本語文字起こしし、
Chrome内蔵のTranslator APIで英訳したうえで、OBS WebSocketの `SendStreamCaption` から
Twitch公式クローズドキャプションへ送出します。視聴者はTwitchプレーヤーのCCをONにすると
英語字幕だけを見られます。映像への焼き込みは行いません。

Whisper・LocalVocal・CUDA・大容量の音声認識モデルは使いません。既存のコメント翻訳
(`commentReader.translation`, en/fr → ja のローカルONNXモデル) とは完全に別系統で、
この機能はそのモデルを一切ロードしません。

## 構成

```text
配信用マイク
  -> 外部Chromeタブ (dociaiが開く字幕ワーカーページ)
       1. SpeechRecognition(lang = ja-JP)
       2. 途中経過(interim)はこのタブ内のプレビューのみ
       3. 確定(final)だけを翻訳へ回す
       4. Translator API (ja -> en)
  -> loopback WebSocket (127.0.0.1)
  -> dociai Electron Main
       5. payload検証・session認証
       6. 重複排除・期限切れ破棄・長文分割・固有名詞置換
       7. CC有効 / OBS配信中 / 対象マイク非ミュート を確認
  -> OBS WebSocket SendStreamCaption
  -> OBS配信出力 -> Twitch公式CC
```

翻訳に失敗した場合、日本語原文へフォールバックせずにその字幕を破棄します。

## 必要なもの

- Electron版 dociai (Browser版にはこの機能はありません)
- デスクトップ版 Google Chrome 138 以降 (Translator API が Stable の版)
- OBS Studio 28 以降 (obs-websocket 5.x を内蔵。`SendStreamCaption` に対応していること)
- Twitchで配信中であること (配信していない間は字幕を送りません)

MVPの第一対象は Windows x64 + デスクトップ版 Google Chrome です。

## セットアップ手順

1. OBS Studio の「ツール」→「WebSocketサーバー設定」でサーバーを有効にし、
   ポート (既定 4455) とパスワードを確認します。
2. dociai の「設定を編集」→「英語CC」タブで次を設定します。
   - 「配信者の日本語音声を英語字幕としてTwitchへ送る」をON
   - OBS WebSocketホスト / ポート
   - OBS WebSocketパスワード (下記「パスワードの扱い」参照)
   - 対象OBSマイク入力名 (例: `Mic/Aux`)。省略するとミュート判定を行いません。
     指定した名前がOBSに存在しない場合は、ミュート状態を確認できないため**字幕の送出を止めます**
     (操作卓のパネルに入力名を確認するよう表示されます)
   - 必要であれば Chrome実行ファイルのパス (省略時は既知パスから自動検出)
3. 設定を保存し、操作卓の「英語CC」パネルで「Chromeを開く」を押します。
   dociaiが字幕ワーカーページを開いたChromeタブを起動します。
4. Chromeタブの「マイクと翻訳を開始」を押します。
   - 初回はマイクの使用許可を求められます。アドレスバーのマイクアイコンから許可してください。
   - 初回は翻訳モデルのダウンロードが走ります。進捗がタブに表示されます。
5. OBSで配信を開始すると、確定した認識結果の英訳がTwitch CCへ送られます。
   操作卓のパネルで「配信 LIVE」「送出」件数を確認できます。
6. 視聴者はTwitchプレーヤーの設定からCCをONにすると英語字幕を表示できます。

停止するときは操作卓の「停止」を押します。Chromeタブを閉じても字幕は止まります。

字幕ワーカーのURLは一度きり有効です。タブを再読み込みするとURLが失効しているため、
操作卓の「Chromeを開く」を押し直してください (ネットワークが一時的に切れただけの場合は、
タブが自動で再接続するので操作は不要です)。

## 操作卓のパネル

| 行 | 意味 |
| --- | --- |
| Chrome | 字幕ワーカーページとのWebSocket接続状態 |
| 認識 | Chrome側の音声認識状態 |
| 翻訳 | Chrome内蔵翻訳の利用可否・ダウンロード状況 |
| OBS | OBS WebSocketへの接続状態 |
| 配信 | OBSが配信中かどうか (`GetStreamStatus` / `StreamStateChanged`) |
| マイク入力 | 対象OBS入力のミュート状態 (`GetInputMute` / `InputMuteStateChanged`) |
| 送出 | 送出できた件数と破棄した件数 |

「テスト字幕」は実際の送出条件をそのまま通すため、送れなかった場合はその理由がそのまま
診断になります (OBS未接続・未配信・ミュート中など)。

## 送出する条件・しない条件

すべて満たすときだけ `SendStreamCaption` を呼びます。

- 英語CCが開始済み
- Chromeワーカーとのsession認証が成功済み
- 音声認識結果がfinal
- ja→en翻訳が成功し、英語本文が空でない
- 結果が期限切れでない (`captions.maxAgeMs`)
- OBS WebSocketが接続済みで `SendStreamCaption` に対応している
- OBSが配信中
- 対象OBSマイク入力が設定されている場合、その入力がミュートされていない

次は送りません。

- 途中経過(interim)の認識結果
- 翻訳失敗 (日本語原文へのフォールバックはしません)
- 英訳結果に日本語 (かな・漢字・全角読点など) が残っているもの
- 直前と完全に同じ字幕
- 期限切れの字幕
- OBS未配信・マイクミュート中
- 停止後に遅れて届いた、停止前の接続からの結果

## 設定項目

`config.captions` (既定はすべてOFF。既存の設定には影響しません)

| キー | 既定 | 説明 |
| --- | --- | --- |
| `enabled` | `false` | 機能全体のON/OFF |
| `sourceLanguage` | `"ja-JP"` | 音声認識の言語 (MVPは ja-JP のみ) |
| `targetLanguage` | `"en"` | 字幕の言語 (MVPは en のみ) |
| `recognitionEngine` | `"chrome-web-speech"` | 音声認識エンジン |
| `translationEngine` | `"chrome-translator"` | 翻訳エンジン |
| `chromeExecutable` | `""` | Chrome実行ファイル。空なら既知パスから自動検出 |
| `workerPort` | `0` | 字幕ワーカーのポート。0でOSに空きポートを選ばせる |
| `obs.host` / `obs.port` | `127.0.0.1` / `4455` | OBS WebSocketの接続先 |
| `obs.microphoneInputName` | `""` | ミュート判定の対象となるOBS入力名。空ならミュート判定なし。名前が存在しない場合は送出を止める |
| `maxPending` | `2` | 送出待ちの上限。超えたら古い方から捨てて現在の発話を優先する |
| `maxAgeMs` | `5000` | 認識確定からこの時間を過ぎた字幕は送らない |
| `maxCaptionChars` | `0` | 1件あたりの最大文字数。0で分割しない |
| `replacements` | `{}` | 固有名詞などの最終置換辞書 |
| `logCaptions` | `false` | 受理をログに残すか (残す場合も本文は出力しません) |

### パスワードの扱い

OBS WebSocketのパスワードは設定ファイルには保存しません。設定の「英語CC」タブの
パスワード欄から保存すると、OSの安全な保管領域 (Electronの safeStorage) へ書き込まれます。

`config.json` / `config.local.json` に `captions.obs.password` を直接書くと設定の検証エラーになります。
設定のエクスポートにもパスワードは含まれません。パスワードを保存すると実行中のセッションへ即座に
反映されるため、変更後に停止・開始をやり直す必要はありません。

## セキュリティとプライバシー

- 字幕ワーカー用のサーバーは `127.0.0.1` でのみ待ち受けます。
- 起動のたびにランダムなsession tokenを発行します。URLに載るのは「ページを1枚取得するための
  一回限りのtoken」だけで、WebSocketの認証に使うtokenはページ本文に埋め込んで渡します。
  URLはコマンドライン・ブラウザ履歴・配信画面のアドレスバーへ露出しうるためです。
  ページ側はロード直後にURLからtokenを取り除きます。
- `Host` / `Origin` は loopback の想定値だけを許可します。
- Chromeはリモートデバッグやセキュリティ無効化フラグなしで起動します。
- 字幕の原文・英訳は既定でディスクに保存しません。通常のログにも本文は出力せず、
  文字数・件数・状態・エラーコードだけを記録します。
- OBSが応答しなくなった場合 (別ホストの電源断など、切断イベントが届かないケース) は、
  一定回数の応答待ちタイムアウトで自分から切断し、通常の再接続へ落とします。
- Chromeの音声認識はGoogleの音声認識サービスへ音声を送信します (端末内認識が有効な環境を除く)。
  この点は字幕ワーカーページ上にも明示しています。翻訳はChrome内蔵のTranslator APIによる
  端末内処理で、外部の翻訳APIへは送信しません。
- 配信者は字幕の内容について責任を負うため、操作卓の「停止」はどの状態でも押せます。

## 未検証の項目 (issue #282 Phase 0)

以下は実機 (実Chrome・実マイク・実OBS・実Twitch) でしか確認できないため、
この実装時点では未検証です。運用前に確認してください。

- Chrome Stable で日本語の連続認識が30分以上継続できるか
- `onend` からの自動再開が長時間配信で安定するか
- Chromeタブをバックグラウンドにしても認識・翻訳が実用上止まらないか
- マイク入力デバイスを明示選択できるか (現状はOS既定の入力のみを想定)
- TwitchのWeb / iOS / Android でCCのON/OFFが機能するか
- 実表示可能な文字数・改行・句読点の扱い (`maxCaptionChars` の実用値)
- 分割した字幕を連続送信したときの表示 (チャンク間に間隔が必要かどうか)
- 2時間連続でChrome・dociai・OBSが異常終了せず、字幕遅延が累積しないか

## 対象外

YouTube字幕トラックへの送出、日本語と英語の複数字幕トラック、映像への焼き込み、
AI音声の自動英訳、ゲーム音やDiscord全体の文字起こし、Whisper/LocalVocal/CUDAの同梱、
翻訳本文のLLM校正、VOD/Clipへの字幕保持保証、Chrome以外のブラウザ対応。
