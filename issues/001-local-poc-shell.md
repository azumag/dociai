## Summary

ローカルHTML/JavaScriptで動くPoCの最小構成を作る。

## Background

最初から配信コメントAPIやOBS連携まで作り込まず、手動コメント入力からAI応答と読み上げまでを確認できる状態を作る。

## Tasks

- `index.html`, `src/`, `styles/` の最小構成を用意する
- `python3 -m http.server 8080` で起動できるようにする
- 手動コメント入力欄を作る
- ログ表示領域を作る
- 設定読み込みボタンを作る

## Acceptance Criteria

- ローカルサーバーでUIが表示できる
- コメントを入力してログに追加できる
- `config.local.example.json` を参考に設定ファイルを読み込める

