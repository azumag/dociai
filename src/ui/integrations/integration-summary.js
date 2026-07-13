import { HEALTH_SEVERITY } from "../../health/integration-health.js";

export const STATUS_LABELS = Object.freeze({
  disabled: "無効", unknown: "不明", checking: "確認中", ready: "正常", degraded: "警告",
  reconnecting: "再接続中", auth_required: "再認証が必要", configuration_required: "設定が必要", error: "エラー",
  retry: "再試行", reauth: "再認証", open_settings: "設定を開く", open_manager: "管理画面", start_service: "開始", open_diagnostics: "診断",
});

export function statusLabel(status) { return STATUS_LABELS[status] ?? status ?? STATUS_LABELS.unknown; }

function servicesArray(services) {
  if (Array.isArray(services)) return services;
  return Object.values(services ?? {});
}

export function summarizeHealth(services) {
  const entries = servicesArray(services);
  const summary = { total: entries.length, ready: 0, warn: 0, error: 0, checking: 0, unknown: 0, critical: 0 };
  for (const service of entries) {
    const status = service?.status ?? "unknown";
    if (status === "ready") summary.ready += 1;
    else if (status === "checking") summary.checking += 1;
    else if (HEALTH_SEVERITY[status] >= 2) { summary.error += 1; if (service?.critical) summary.critical += 1; }
    else if (HEALTH_SEVERITY[status] >= 1) summary.warn += 1;
    else summary.unknown += 1;
  }
  summary.overall = summary.error > 0 ? "error" : summary.warn > 0 ? "degraded" : summary.checking > 0 ? "checking" : summary.ready > 0 ? "ready" : "unknown";
  return summary;
}

export function renderSummary(root, services, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return summarizeHealth(services);
  const summary = summarizeHealth(services);
  root.replaceChildren();
  const items = [
    ["ready", summary.ready, `正常 ${summary.ready}`], ["warn", summary.warn, `警告 ${summary.warn}`], ["error", summary.error, `エラー ${summary.error}`],
    ["checking", summary.checking, `確認中 ${summary.checking}`], ["unknown", summary.unknown, `不明 ${summary.unknown}`],
  ];
  for (const [status, count, label] of items) {
    const item = document.createElement("span");
    // count===0のバッジは信号色(警告=琥珀・エラー=赤等)を消灯させる — 色は実際に何かある
    // ときだけ意味を持たせる、という本体デザインの信号灯規律をヘルスサマリーにも適用する。
    // 0件の項目が常時琥珀/赤で点灯していると、その規律がここだけ薄れて見えるため。
    item.className = `integration-summary-item is-${status}${count === 0 ? " is-zero" : ""}`;
    item.dataset.status = status;
    item.setAttribute("aria-label", label);
    item.textContent = label;
    root.append(item);
  }
  root.dataset.overall = summary.overall;
  root.setAttribute("aria-label", `連携ヘルス: ${statusLabel(summary.overall)}、${summary.total}件`);
  return summary;
}
