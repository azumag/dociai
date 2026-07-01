## Summary

AI応答を音声読み上げするキューを作る。

## Background

複数ペルソナが同時に話すと配信が聞きづらくなるため、音声は順番に制御する。

## Tasks

- `SpeechQueue` を実装する
- Web Speech APIで読み上げる
- 読み上げ中、待機中、完了、失敗の状態をログに出す
- キューの停止、スキップ、全消去を実装する
- ペルソナごとの `rate`, `pitch`, `voice` を反映する

## Acceptance Criteria

- AI応答が順番に読み上げられる
- 読み上げを手動停止できる
- 同時発話が起きない

