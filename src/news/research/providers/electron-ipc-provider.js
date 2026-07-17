// Electron IPC経由のresearch provider共通処理 (issue #190レビュー指摘の修正)。
// news-search/wikipedia providerで重複していたrequestId生成・abort配線・エラー正規化を
// ここへ集約する。

import { RequestCancelledError } from "../../../runtime/request-registry.js";

// 注意: `call`へcontext.generationを渡さないこと。context.generationはRenderer側の
// RuntimeGenerationManagerが刻む世代であり、対応するElectron Main側ServiceRuntimeの
// generationとは無関係 (誰もreload()を呼ばず常に0のまま) — 渡すと`generation !==
// this.runtime.generation`が常に成立し、毎回CANCELLEDとして失敗する
// (legacy-news-adapter.jsのfeed取得がgenerationを渡さないのと同じ理由)。
export async function callElectronResearchIpc({ prefix, query, context, call, cancel }) {
  const requestId = `${context?.requestId ?? "news"}:${prefix}:${query}`;
  const onAbort = () => { void cancel(requestId); };
  context?.signal?.addEventListener("abort", onAbort, { once: true });
  let result;
  try {
    result = await call(requestId);
  } finally {
    context?.signal?.removeEventListener("abort", onAbort);
  }
  if (result?.ok) return result.value;
  if (result?.error?.code === "CANCELLED") throw new RequestCancelledError();
  throw new Error(result?.error?.message ?? "調査に失敗しました");
}
