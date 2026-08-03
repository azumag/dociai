// issue #257 (PR #269 review指摘): commentReader.translation.timeoutMsの既定値を3000msから
// 25000msへ引き上げたが (config-defaults.js)、既定値は「未設定の項目」にしか効かない —
// settings-ui.jsは翻訳設定を開くたびに `t.timeoutMs ?? 3000` を実際の保存値として書き込むため、
// 翻訳を有効化したことがあるユーザーの設定には旧既定値3000が明示的に永続化されている。
// このmigrationが無いと、まさにこの不具合を踏んだユーザー本人の設定だけが新しい既定値の
// 恩恵を受けられない。「ユーザーが意図して3000msを指定した」場合と区別できないが、旧既定値と
// 完全一致する値だけを対象にする以上、それを狙って選んだユーザーは極めて稀という前提を取る。
export const migrationV2ToV3 = Object.freeze({
  id: "v2-to-v3", from: 2, to: 3,
  migrate(input) {
    const config = structuredClone(input);
    if (config.commentReader?.translation?.timeoutMs === 3000) config.commentReader.translation.timeoutMs = 25000;
    config.schemaVersion = 3;
    return { config, notes: [] };
  },
});
