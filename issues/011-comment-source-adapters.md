## Summary

YouTube/Twitchなどのコメント取得アダプタを設計する。

## Background

初期PoCは手動コメント入力で始めるが、最終的には配信コメントを監視して自動反応する。

## Tasks

- `CommentSource` インターフェースを定義する
- 手動入力アダプタを実装する
- YouTube Live Chat取得方法を調査する
- Twitch Chat取得方法を調査する
- 認証方式と必要権限を整理する

## Acceptance Criteria

- 手動入力と実コメント取得を同じ `CommentStore` に流し込める設計になっている
- YouTube/Twitch連携の実装方針がIssueまたはDocsにまとまっている

