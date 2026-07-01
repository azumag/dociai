## Summary

APIキーを安全に扱うための最低限のガードを入れる。

## Background

LocalStorageにAPIキーを保存するとXSS、拡張機能、共有PC、配信画面映り込みなどのリスクがある。

## Tasks

- APIキーをLocalStorage/SessionStorageに保存しない
- 設定画面でAPIキーをマスク表示する
- ログにAPIキーが出ないようにする
- `config.local.json` がGit管理されないことを確認する
- 公開デプロイ時に `config.local.json` を含めない注意書きを追加する

## Acceptance Criteria

- APIキーがブラウザ永続ストレージに残らない
- エラーログやデバッグ表示にAPIキーが出ない
- `.gitignore` に `config.local.json` が含まれている

