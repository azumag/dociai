## Summary

複数プロバイダに対応するAIコネクタ抽象化を作る。

## Background

OpenAI、OpenRouter、Gemini、ローカルLLMなどを将来的に切り替えられるよう、ペルソナから直接APIを呼ばず `connector` 経由にする。

## Tasks

- `AIConnector` インターフェースを定義する
- OpenAI互換Chat Completionsコネクタを作る
- OpenRouterコネクタを作る
- モックコネクタを作る
- エラー、タイムアウト、レート制限時の表示を作る

## Acceptance Criteria

- ペルソナ設定の `connector` IDからモデルを呼び出せる
- モックコネクタでAPIキーなしの動作確認ができる
- プロバイダ差分がUIやペルソナ処理に漏れない

