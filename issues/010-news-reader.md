## Summary

時事ニュースを取得、要約、読み上げる `NewsReader` を作る。

## Background

配信の合間に時事ニュースを読み上げる機能を入れる。参考実装として `azumag/soviet_now` の構造を確認する。

## Tasks

- RSS取得処理を作る
- 既読ニュースをメモリ上で管理する
- ニュース本文または概要を短く整形する
- AIで配信用の自然な読み上げ文に要約する
- `SpeechQueue` に投入する
- `soviet_now` の構造を確認し、移植できる部分をメモする

## Acceptance Criteria

- 設定したRSSからニュース候補を取得できる
- 既に読んだニュースを重複して読まない
- `interval` トリガーでニュース読み上げが走る

