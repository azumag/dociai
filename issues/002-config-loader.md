## Summary

`config.local.json` またはファイル選択から設定を読み込む仕組みを作る。

## Background

APIキーはブラウザに永続保存しない。PoCではローカルファイルとして設定を持ち、読み込み後はメモリ上だけで扱う。

## Tasks

- `ConfigLoader` を実装する
- `fetch("./config.local.json")` 方式を実装する
- ファイル選択方式を実装する
- JSONスキーマ相当の簡易バリデーションを入れる
- APIキーをLocalStorageに保存しないことを確認する

## Acceptance Criteria

- 設定ファイルから `connectors`, `personas`, `triggers`, `news` を読み込める
- APIキーを含む設定はメモリ保持のみになる
- 設定エラーがUIに表示される

