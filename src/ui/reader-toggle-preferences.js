// 自動読み上げトグル (news/topics runtime toggle) のON/OFFを再起動をまたいで保持する。
// このトグルはもともと「このセッションだけ一時停止する」ものだったが (src/app/boot.js の
// #chk-news-enabled/#chk-topics-enabled title参照)、要望によりソフト立ち上げ時のデフォルトを
// 前回選んだ状態にしたい。config (config.local.json) には保存しない — src/app/runtime-factory.js
// 側のテストが「操作卓トグルはconfigを絶対に変異しない」ことを保証しており (scripts/test/
// runtime-factory.test.mjs)、その前提を崩さないためレンダラーのlocalStorageに独立して持つ。
//
// APIキー等の機密情報は絶対にここへ書かない (issue #13, src/security.js の方針) —
// 保存するのは非機密のtoggle状態(boolean)2つだけ。
const STORAGE_KEY = "dociai:reader-toggles";

// storageを明示的に渡さない場合はglobalThis.localStorageを使う。プライベートブラウジング等で
// localStorageへのアクセス自体がthrowする環境や、Node上のテスト実行 (localStorage未定義) でも
// 落ちないようtry/catchで握りつぶし、「保存なし」として扱う。
function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadReaderToggles(storage = defaultStorage()) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out = {};
    if (typeof parsed?.newsRuntimeEnabled === "boolean") out.newsRuntimeEnabled = parsed.newsRuntimeEnabled;
    if (typeof parsed?.topicsRuntimeEnabled === "boolean") out.topicsRuntimeEnabled = parsed.topicsRuntimeEnabled;
    return out;
  } catch {
    // 壊れたJSON等は「保存なし」と同じ扱いにする (呼び出し側の既定値trueにフォールバック)。
    return {};
  }
}

export function saveReaderToggles({ newsRuntimeEnabled, topicsRuntimeEnabled }, storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ newsRuntimeEnabled, topicsRuntimeEnabled }));
  } catch {
    // 永続化の失敗 (quota超過等) でアプリの動作を止めない — 次回起動時は既定値に戻るだけ。
  }
}
