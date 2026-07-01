## Summary

配信画面をキャプチャし、画面状況をAI文脈として使う。

## Background

コメントだけでなく、現在の配信画面に即した反応を行うために、画面キャプチャと画像説明を扱う。

## Tasks

- `getDisplayMedia()` で画面/ウィンドウ/タブを選べるようにする
- 任意タイミングでフレームをcanvasへ取り込む
- 画像をAI Visionモデルへ送る処理を作る
- `screenSummary` と取得時刻を保持する
- `maxAgeSeconds` を超えた画面文脈は使わない

## Acceptance Criteria

- ショートカットまたはボタンで画面文脈を更新できる
- AI応答に画面状況が反映される
- 古い画面説明が誤って使われ続けない

