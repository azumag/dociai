## Summary

キーワード、ショートカット、定期実行、手動実行などのトリガーを実装する。

## Background

コメント全件に反応すると騒がしくなるため、どの条件でAIが反応するかを設定できるようにする。

## Tasks

- `TriggerEngine` を実装する
- `keyword` トリガーを実装する
- `hotkey` トリガーを実装する
- `interval` トリガーを実装する
- `random` トリガーを実装する
- UIから手動発火できるようにする

## Acceptance Criteria

- `config.local.json` の `triggers` 設定で発火条件を変更できる
- `Alt+1` などのショートカットで指定ペルソナを発火できる
- キーワードに反応してAI応答が始まる

