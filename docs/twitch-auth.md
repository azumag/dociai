# Twitch 認可設定 (issue #51)

`electron/main/services/twitch/auth/` は Twitch の Device Code Grant Flow (Public client, client secret 不要) で認可する。事前に Twitch Developer Console 側の設定が必要。

## Twitch アプリ登録手順

1. https://dev.twitch.tv/console/apps へアクセスし、"Register Your Application" から新規アプリを作成する。
2. **Category** は任意 (例: "Application Integration")。
3. **OAuth Redirect URLs** は Device Code Grant では使用しないが、Twitch Console 上は最低1件の入力を要求されるため `https://localhost` 等のダミー値を入れておく。
4. **Client Type** は必ず **Public** を選択する。Confidential を選ぶと Device Code Grant の挙動 (特に refresh token rotation の扱い) が変わるため、本実装の前提が崩れる。
5. 発行された **Client ID** を控える。Client Secret は発行されない (Public client のため) か、発行されても本実装では一切使用・保存しない。

## 必要 scope

機能ごとに要求する scope は `twitch-scope-registry.ts` に集約している。

| 機能 | scope |
|---|---|
| Bits イベント読み取り | `bits:read` |
| サブスクライブイベント読み取り | `channel:read:subscriptions` |
| チャネルポイント引換読み取り | `channel:read:redemptions` |

`manage` 系 scope (例: `channel:manage:redemptions`) は、状態を変更する機能を実装するまで要求しない。

## 実装の対応関係

| 要件 | 実装 |
|---|---|
| Device Code Grant 状態機械・polling | `device-code-flow.ts`, `twitch-oauth-client.ts` (#83) |
| token 保存・validate・refresh rotation | `twitch-token-provider.ts`, `twitch-token-validator.ts`, `twitch-token-refresher.ts`, `token-refresh-mutex.ts` (#84) |
| feature scope・account 切替・logout/revoke | `twitch-scope-registry.ts`, `twitch-account-service.ts`, `twitch-auth-coordinator.ts`, `twitch-revoke-client.ts` (#85) |

Client ID は `electron/main/secrets/*` (#42 SecretStore) 経由ではなく、通常の設定値として扱う (secret ではないため)。Access/refresh token は SecretStore にのみ保存し、Renderer や通常ログには一切渡さない。

## 未実装 (フォローアップ)

- Renderer からの実際の認可導線 (IPC 配線・認可 UI) は `#94` ([Twitch UI] Preflight・認可・接続・購読overview) で実装する。`#51` は `#94` 完了後にクローズする。
