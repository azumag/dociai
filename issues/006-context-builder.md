## Summary

コメント履歴、画面文脈、ニュース文脈をAIプロンプトにまとめる。

## Background

AIに渡す情報を毎回ベタに組み立てると破綻しやすいので、`ContextBuilder` で一元管理する。

## Tasks

- `ContextBuilder` を実装する
- ペルソナの `systemPrompt` と共通ルールを合成する
- 直近コメントを整形する
- `screenSummary` を必要な時だけ入れる
- ニュース読み上げ時はニュース文脈を入れる

## Acceptance Criteria

- AI呼び出し前のプロンプト内容をデバッグ表示できる
- コメント、画面、ニュースの文脈を設定に応じて出し分けられる
- 長すぎる入力を切り詰められる

