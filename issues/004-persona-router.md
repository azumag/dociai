## Summary

複数ペルソナを管理し、コメントやトリガーに応じて反応するペルソナを選ぶ。

## Background

配信の相棒AI、ツッコミAI、解説AI、ニュース読み上げAIなどを切り替えられるようにする。

## Tasks

- `PersonaRouter` を実装する
- ペルソナのON/OFFを扱う
- `maxRepliesPerComment` を守る
- `cooldownSeconds` を守る
- 手動でペルソナを指定できるようにする

## Acceptance Criteria

- 1コメントにつき最大応答数を制御できる
- 無効化されたペルソナは反応しない
- ペルソナごとのモデル、プロンプト、音声設定が使われる

